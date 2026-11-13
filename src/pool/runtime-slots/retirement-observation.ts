import { RuntimeActivity } from "./activity.ts";
import { SlotRefused, sameIdentity, type SlotIdentity } from "./contract.ts";
import { RuntimeWitnessStore } from "./witness-store.ts";
import type { RuntimeState } from "./runtime-state.ts";
import { RuntimeRetirementTrace } from "../runtime-retirement-trace.ts";

/** A stopped runtime plus its retained zero-activity intent recovers a lost destroy acknowledgement. */
export async function observeRuntimeRetirement(
  identity: SlotIdentity,
  container: NonNullable<RuntimeState["container"]>,
  store: RuntimeWitnessStore,
  activity: RuntimeActivity,
  trace: RuntimeRetirementTrace,
  signal?: AbortSignal,
) {
  const record = await trace.run(
    "witness_read",
    () => store.retained(identity.slotId),
    undefined,
    signal,
  );
  if (!record || !sameIdentity(record.identity, identity)) throw new SlotRefused("identity");
  const running = container.running;
  let retired = record.retired === true;
  if (!retired && !running) {
    const retained = await trace.run(
      "activity_read",
      () => activity.inspect(identity),
      undefined,
      signal,
    );
    if (retained?.phase === "retiring" && retained.known && retained.active === 0) {
      await trace.run(
        "retired_record",
        () => store.put(identity, { ...record, retired: true }),
        () => ({ recovered: true }),
        signal,
      );
      retired = true;
    }
  }
  return { identity, retired, running };
}
