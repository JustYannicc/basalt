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
  action?: "inspect";
};

/** Both calls exist in the baseline protocol. Neither starts, adopts, promotes or repairs a runtime. */
export async function baselineControllerHealth(input: {
  baseline: BaselineController;
  key: string;
  target?: PoolOperationsTarget;
  record?(call: BaselineRead): Promise<void>;
}) {
  const { baseline } = input;
  const bridge = await openPoolOperations(input.target ?? baseline.target);
  const signal = AbortSignal.timeout(30_000);
  try {
    const at = Date.now();
    const envelope = await signEnvelope(input.key, runtimeHandoffCommandPrefix, {
      action: "inspect",
      controllerCode: baseline.code,
      at,
      expiresAt: at + 60_000,
    });
    await input.record?.({ method: "POST", path: runtimeHandoffPath, action: "inspect" });
    const inspected = await bounded(
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
    if (inspected.status !== 200) {
      await inspected.body?.cancel();
      throw new BarrierRefusal("baseline-controller-identity-refused", "PoolWorker");
    }
    const inspection = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          controllerCode: ControllerCode,
          selection: Schema.optional(Schema.Unknown),
        }),
      }),
    )(await bounded(inspected.json(), signal)).result;
    sameProvisioningValue("baseline-controller.code", baseline.code, inspection.controllerCode);
    // This path proves the legacy PoolContainer before the first slot handoff.
    if (inspection.selection !== undefined)
      throw new BarrierRefusal("baseline-controller-selection-unexpected", "PoolWorker");
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
  } finally {
    await bounded(bridge.close(), signal);
  }
}
