import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, Redacted, Schema } from "effect";
import { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import {
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { runtimeRecoveryPath } from "../../src/pool/runtime-recovery.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { bounded } from "../database-budget-readiness.ts";
import { openPoolOperations, type PoolOperationsTarget } from "../pool-operations.ts";
import { readBaseline } from "./cloudflare.ts";
import { encodedRecordHash } from "./forward-model.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import { BarrierRefusal } from "./refusal.ts";
import type { RuntimeCommandAction } from "./runtime-command-rpc.ts";

export const BaselineController = Schema.Struct({
  code: ControllerCode,
  target: Schema.Struct({ worker: Schema.NonEmptyString, accountId: Schema.NonEmptyString }),
  imageHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{1,64}$/u)),
  versions: Schema.Array(
    Schema.Struct({ versionId: Schema.NonEmptyString, percentage: Schema.Number }),
  ),
  workerDigest: Schema.String,
  readinessDigest: Schema.String,
});
export type BaselineController = typeof BaselineController.Type;
const envSchema = Schema.Struct({ env: Schema.Record(Schema.String, Schema.Unknown) });
const text = (value: unknown) => {
  const raw = Redacted.isRedacted(value) ? Redacted.value(value) : value;
  if (typeof raw !== "string" || !raw)
    throw new BarrierRefusal("baseline-controller-setting-unavailable", "PoolWorker");
  return raw;
};

export const readBaselineControllerKey = (stack: Pick<CompiledStack, "name" | "stage">) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const worker = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "PoolWorker" });
    if (
      !worker ||
      (worker.status !== "created" && worker.status !== "updated") ||
      worker.resourceType !== "Cloudflare.Worker"
    )
      throw new BarrierRefusal("baseline-controller-native-state-unsettled", "PoolWorker");
    return text(Schema.decodeUnknownSync(envSchema)(worker.props).env.POOL_DEPLOYMENT_KEY);
  });

/** The persisted readiness command records the code that finished the previous deployment, not this checkout's code. */
export const readBaselineController = (stack: Pick<CompiledStack, "name" | "stage">) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const key = { stack: stack.name, stage: stack.stage };
    const worker = yield* state.get({ ...key, fqn: "PoolWorker" });
    const ready = yield* state.get({ ...key, fqn: "PoolBackendBudgetRuntimeReady" });
    if (
      !worker ||
      !ready ||
      (worker.status !== "created" && worker.status !== "updated") ||
      (ready.status !== "created" && ready.status !== "updated") ||
      worker.resourceType !== "Cloudflare.Worker" ||
      ready.resourceType !== "Command.Exec"
    )
      throw new BarrierRefusal("baseline-controller-native-state-unsettled", "PoolWorker");
    const env = Schema.decodeUnknownSync(envSchema)(ready.props).env;
    const workerEnv = Schema.decodeUnknownSync(envSchema)(worker.props).env;
    const identity = Schema.decodeUnknownSync(
      Schema.Struct({ accountId: Schema.String, workerName: Schema.String }),
    )(worker.attr);
    const target = {
      accountId: text(env.CLOUDFLARE_ACCOUNT_ID),
      worker: text(env.DATABASE_BUDGET_WORKER),
    };
    sameProvisioningValue(
      "baseline-controller.target",
      { accountId: identity.accountId, worker: identity.workerName },
      target,
    );
    sameProvisioningValue(
      "baseline-controller.image",
      text(workerEnv.POOL_IMAGE_HASH),
      text(env.DATABASE_BUDGET_IMAGE_HASH),
    );
    const versions = yield* readBaseline({
      accountId: target.accountId,
      scriptName: target.worker,
    });
    return Schema.decodeUnknownSync(BaselineController)({
      code: {
        candidate: text(env.GITHUB_SHA),
        workerInput: text(env.DATABASE_BUDGET_WORKER_INPUT),
      },
      target,
      imageHash: text(env.DATABASE_BUDGET_IMAGE_HASH),
      versions,
      workerDigest: encodedRecordHash(worker),
      readinessDigest: encodedRecordHash(ready),
    });
  });

export type BaselineRead = {
  method: "GET" | "POST";
  path: typeof runtimeRecoveryPath | typeof runtimeHandoffPath;
  action?: "inspect" | "active-health" | "fleet-inspect" | "witness";
};
type PoolOperationsBridge = Awaited<ReturnType<typeof openPoolOperations>>;

/**
 * Runs one sequence of signed reads over one bridge. Opening and closing have their own deadlines,
 * and a close that fails or times out never replaces the reads' own refusal.
 */
export async function withPoolOperations<T>(
  target: PoolOperationsTarget,
  reads: (bridge: PoolOperationsBridge, signal: AbortSignal) => Promise<T>,
) {
  const opening = openPoolOperations(target);
  const bridge = await bounded(opening, AbortSignal.timeout(60_000)).catch((error: unknown) => {
    // A bridge that opens after its deadline still holds a platform to dispose.
    void opening.then((late) => late.close()).catch(() => {});
    throw error;
  });
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await reads(bridge, AbortSignal.timeout(30_000)) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const closed = bounded(bridge.close(), AbortSignal.timeout(10_000));
  if (!outcome.ok) {
    await closed.catch(() => {});
    throw outcome.error;
  }
  await closed;
  return outcome.value;
}

/** One signed send of a read-only handoff action. The caller owns the response body. */
export async function handoffRead(input: {
  bridge: PoolOperationsBridge;
  key: string;
  code: BaselineController["code"];
  action: RuntimeCommandAction & { action: NonNullable<BaselineRead["action"]> };
  signal: AbortSignal;
  record?(call: BaselineRead): Promise<void>;
  /** Runs right before the send, so a caller can time only this request on an open bridge. */
  dispatched?(): void;
}) {
  const at = Date.now();
  const envelope = await signEnvelope(input.key, runtimeHandoffCommandPrefix, {
    ...input.action,
    controllerCode: input.code,
    at,
    expiresAt: at + 60_000,
  });
  await input.record?.({ method: "POST", path: runtimeHandoffPath, action: input.action.action });
  const { bridge, signal } = input;
  input.dispatched?.();
  return bounded(
    bridge.service.fetch(
      new Request(`http://pool-operations${runtimeHandoffPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope }),
        signal,
      }),
    ),
    signal,
  );
}

/** An inspect answered by exactly this controller code, with no slot selection retained. */
export async function readUnselectedInspection(
  response: Response,
  signal: AbortSignal,
  code: BaselineController["code"],
  refusals: { refused: string; codePath: string; selection: string },
) {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new BarrierRefusal(refusals.refused, "PoolWorker");
  }
  const inspection = Schema.decodeUnknownSync(
    Schema.Struct({
      result: Schema.Struct({
        controllerCode: ControllerCode,
        selection: Schema.optional(Schema.Unknown),
      }),
    }),
  )(await bounded(response.json(), signal)).result;
  sameProvisioningValue(refusals.codePath, code, inspection.controllerCode);
  if (inspection.selection !== undefined)
    throw new BarrierRefusal(refusals.selection, "PoolWorker");
}

/** Both calls exist in the baseline protocol. Neither starts, adopts, promotes or repairs a runtime. */
export async function baselineControllerHealth(input: {
  baseline: BaselineController;
  key: string;
  target?: PoolOperationsTarget;
  record?(call: BaselineRead): Promise<void>;
}) {
  const { baseline } = input;
  return withPoolOperations(input.target ?? baseline.target, async (bridge, signal) => {
    // This path proves the legacy PoolContainer before the first slot handoff.
    await readUnselectedInspection(
      await handoffRead({
        bridge,
        key: input.key,
        code: baseline.code,
        action: { action: "inspect" },
        signal,
        record: input.record,
      }),
      signal,
      baseline.code,
      {
        refused: "baseline-controller-identity-refused",
        codePath: "baseline-controller.code",
        selection: "baseline-controller-selection-unexpected",
      },
    );
    await input.record?.({ method: "GET", path: runtimeRecoveryPath });
    const response = await bounded(
      bridge.service.fetch(new Request(`http://pool-operations${runtimeRecoveryPath}`, { signal })),
      signal,
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new BarrierRefusal("baseline-controller-health-refused", "PoolWorker");
    }
    const health = Schema.decodeUnknownSync(
      Schema.Struct({
        instanceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
        imageHash: Schema.String,
        release: Schema.String,
        running: Schema.Literal(true),
        ready: Schema.Literal(true),
        bootId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u)),
      }),
    )(await bounded(response.json(), signal));
    sameProvisioningValue(
      "baseline-controller.health-code",
      baseline.code.candidate,
      health.release,
    );
    sameProvisioningValue("baseline-controller.health-image", baseline.imageHash, health.imageHash);
    return { instanceId: health.instanceId, bootId: health.bootId, checkedAt: Date.now() };
  });
}
