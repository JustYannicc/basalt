import { Config, Effect, Redacted, Schema } from "effect";
import type { CompiledStack } from "alchemy/Stack";
import { StartupWitness } from "../../src/pool/runtime-slots/admission-proof.ts";
import { StartupAbortReceipt } from "../../src/pool/runtime-slots/startup-abort-contract.ts";
import { runtimeReleaseJournal, type RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { runtimeReleaseClient, type RuntimeReleaseClient } from "./runtime-release-client.ts";
import type { RuntimeReleaseWriter } from "./runtime-release-writer.ts";
import { runtimeHandoffDigest } from "./runtime-slot-manifest.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";

export async function runRuntimeAbort(input: {
  record: RuntimeReleaseRecord;
  client: Pick<RuntimeReleaseClient, "call" | "inspect" | "health">;
  mode: string;
  save(record: RuntimeReleaseRecord): Promise<void>;
}) {
  const { record, client, mode } = input;
  const startup = record.promotion?.startup;
  if (record.complete || !startup?.selection.active)
    throw new BarrierRefusal("runtime-abort-startup-not-pending", "PoolWorker");
  if (mode !== "plan" && mode !== "inspect" && !/^[a-f0-9]{64}$/u.test(mode))
    throw new BarrierRefusal("runtime-abort-plan-digest-required", "PoolWorker");
  const operationId = `abort-${record.candidate}-${digest(canonical(startup)).slice(0, 16)}`;
  let receipt = record.abort;
  let fingerprint = record.abortPlanDigest;
  if (!receipt) {
    const before = await client.inspect();
    await client.health();
    sameProvisioningValue(
      "runtime-abort.active",
      startup.selection.active,
      before.selection?.active.identity,
    );
    sameProvisioningValue(
      "runtime-abort.epoch",
      startup.selection.expectedEpoch,
      before.selection?.epoch,
    );
    sameProvisioningValue(
      "runtime-abort.candidate",
      startup.target,
      before.selection?.candidate?.target,
    );
    const witness = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          witness: Schema.optional(StartupWitness),
        }),
      }),
    )(await client.call({ action: "witness", target: startup.target })).result.witness;
    if (witness) {
      sameProvisioningValue(
        "runtime-abort.witness-operation",
        startup.operationId,
        witness.operationId,
      );
      sameProvisioningValue(
        "runtime-abort.witness-manifest",
        runtimeHandoffDigest(startup),
        witness.manifestDigest,
      );
      sameProvisioningValue(
        "runtime-abort.witness-configuration",
        startup.configurationFingerprint,
        witness.configurationFingerprint,
      );
    }
    receipt = {
      status: "pending",
      sent: true,
      intent: {
        operationId,
        target: startup.target,
        startupOperationId: startup.operationId,
        expectedEpoch: startup.selection.expectedEpoch,
        active: startup.selection.active,
        witness: witness ?? null,
      },
    };
    fingerprint = digest(
      canonical({ candidate: record.candidate, startup, intent: receipt.intent }),
    );
  }
  if (mode === "plan")
    return {
      candidate: record.candidate,
      fingerprint,
      intent: receipt.intent,
      status: receipt.status,
    };
  if (mode !== "inspect") sameProvisioningValue("runtime-abort.plan-digest", fingerprint, mode);
  let response: unknown;
  if (!record.abort && mode !== "inspect") {
    // Unknown dispatch remains pending in the encrypted journal before the one stop send.
    await input.save({ ...record, abort: receipt, abortPlanDigest: fingerprint });
    try {
      response = await client.call({ action: "startup-abort", intent: receipt.intent }, true);
    } catch {}
  }
  if (response === undefined) {
    try {
      response = await client.call({ action: "startup-abort-inspect", operationId });
    } catch {}
  }
  if (response !== undefined) {
    const observed = Schema.decodeUnknownSync(Schema.Struct({ result: StartupAbortReceipt }))(
      response,
    ).result;
    sameProvisioningValue("runtime-abort.receipt-intent", receipt.intent, observed.intent);
    receipt = observed;
    await input.save({ ...record, abort: receipt, abortPlanDigest: fingerprint });
  }
  return { candidate: record.candidate, fingerprint, ...receipt };
}

/** Reuses the ordinary deploy writer, encrypted State journal and signed controller bridge. */
export const abortRuntimeRelease = (
  stack: CompiledStack,
  writer: RuntimeReleaseWriter,
  mode: string,
) =>
  Effect.gen(function* () {
    const key = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY");
    const journal = yield* runtimeReleaseJournal(stack, writer, Redacted.value(key));
    const record = yield* Effect.promise(journal.read);
    if (!record?.promotion)
      throw new BarrierRefusal("runtime-abort-release-not-pending", "PoolWorker");
    const client = yield* runtimeReleaseClient({
      state: record.baseline,
      code: record.promotion.startup.controllerCode,
      writer,
      promotion: {
        read: async () => record.promotion,
        write: async () => {
          throw new BarrierRefusal("runtime-abort-promotion-forbidden");
        },
      },
    });
    return yield* Effect.promise(() =>
      runRuntimeAbort({ record, client, mode, save: journal.write }),
    );
  });
