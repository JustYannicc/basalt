import { RuntimeFleetState } from "../../../src/pool/runtime-fleet/state.ts";
import { RuntimeActivity } from "../../../src/pool/runtime-slots/activity.ts";
import { RuntimeWitnessStore } from "../../../src/pool/runtime-slots/witness-store.ts";
import { sameTarget, type SlotTarget } from "../../../src/pool/runtime-slots/contract.ts";
import type { ControllerState } from "../../../src/pool/runtime-slots/runtime-state.ts";
import type { TransactionStorage } from "../../../src/pool/runtime-slots/storage.ts";

/** Each real DO reads only its own store; the stage coordinator joins the independent snapshots. */
export async function fleetStageRootState(target: SlotTarget, storage: TransactionStorage) {
  return (await new RuntimeFleetState(storage, 4).inspect()).find((row) =>
    sameTarget(row.target, target),
  );
}

export async function fleetStageEndpointState(
  target: SlotTarget,
  storage: ControllerState["storage"],
) {
  const retained = await new RuntimeWitnessStore(storage, "").retained(target.slotId);
  if (retained && !sameTarget(retained.authorization.target, target))
    throw new Error("Stage endpoint target drift");
  const identity = retained?.identity;
  const activity = identity ? await new RuntimeActivity(storage).inspect(identity) : undefined;
  return (
    retained && {
      target: retained.authorization.target,
      configurationFingerprint: retained.authorization.configurationFingerprint,
      identity,
      witness: retained.witness,
      retired: retained.retired ?? false,
      activity,
    }
  );
}

/** A convenience for in-process fixtures. These reads neither start compute nor advance lifecycle state. */
export async function fleetStageState(
  target: SlotTarget,
  stores: { root: TransactionStorage; endpoint: ControllerState["storage"] },
) {
  const [root, endpoint] = await Promise.all([
    fleetStageRootState(target, stores.root),
    fleetStageEndpointState(target, stores.endpoint),
  ]);
  return { root, endpoint };
}
