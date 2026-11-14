import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";
import { SlotIdentity, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import { RuntimeStageRecord } from "../../src/pool/runtime-slots/staging.ts";
import { BarrierRefusal } from "./refusal.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import type { RuntimeCommandCall } from "./runtime-command-rpc.ts";

/** An uncertain stage send permits only bounded observation of the original operation. */
export async function awaitRuntimeStartup(input: {
  call: RuntimeCommandCall;
  target: SlotTarget;
  operationId: string;
  proof?: string;
}) {
  const began = Date.now();
  let deadline = began + 180_000;
  let response: unknown;
  const signal = AbortSignal.timeout(180_000);
  if (input.proof) {
    try {
      response = await input.call({ action: "stage", proof: input.proof }, true, signal);
    } catch (error) {
      if (error instanceof BarrierRefusal) throw error;
    }
  }
  for (;;) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new BarrierRefusal("runtime-startup-deadline", "PoolWorker");
    if (response !== undefined) {
      const record = Schema.decodeUnknownSync(Schema.Struct({ result: RuntimeStageRecord }))(
        response,
      ).result;
      sameProvisioningValue("runtime-startup.target", input.target, record.target);
      sameProvisioningValue("runtime-startup.operation", input.operationId, record.operationId);
      deadline = Math.min(deadline, record.deadline);
      if (record.status === "failed")
        throw new BarrierRefusal("runtime-startup-failed", "PoolWorker");
      if (record.status === "ready") {
        if (Date.now() >= deadline)
          throw new BarrierRefusal("runtime-startup-deadline", "PoolWorker");
        const identity = Schema.decodeUnknownSync(SlotIdentity)(record.identity);
        sameProvisioningValue(
          "runtime-startup.identity",
          input.target,
          Schema.decodeUnknownSync(SlotTarget)(identity),
        );
        return identity;
      }
    }
    await setTimeout(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
    try {
      response = await input.call(
        { action: "stage-inspect", target: input.target },
        false,
        AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
      );
    } catch (error) {
      if (error instanceof BarrierRefusal) throw error;
      response = undefined;
    }
  }
}
