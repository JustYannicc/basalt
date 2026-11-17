import type { SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import { BarrierRefusal } from "./refusal.ts";
import type { RuntimeReleaseState } from "./runtime-release-state.ts";

/** The legacy slot `adopt` retains for the serving root container; settlement reads the same one. */
export function legacyAdoptionTarget(
  root: RuntimeReleaseState["applications"]["root"],
  instanceId: string,
): SlotTarget {
  const imageDigest = root.attributes.configuration.image.split("@")[1];
  if (!imageDigest) throw new BarrierRefusal("legacy-adoption-image-digest-missing", root.resource);
  return {
    format: "pool-runtime-slot-v1",
    controllerId: instanceId,
    instanceId,
    slotId: "legacy",
    applicationId: root.attributes.applicationId,
    applicationVersion: String(root.attributes.version),
    imageDigest,
    imageInput: root.image.inputHash,
  };
}
