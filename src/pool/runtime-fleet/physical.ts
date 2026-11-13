import { Schema } from "effect";
import { SlotSelection, type SlotTarget } from "../runtime-slots/contract.ts";
import { slotSelectionKey, type SlotStorage } from "../runtime-slots/storage.ts";

export const sameGeneration = (left: SlotTarget, right: SlotTarget) =>
  left.applicationId === right.applicationId &&
  left.applicationVersion === right.applicationVersion &&
  left.imageDigest === right.imageDigest &&
  left.imageInput === right.imageInput;

export async function selectedPrimary(storage: SlotStorage) {
  const value = await storage.get(slotSelectionKey);
  return value === undefined
    ? undefined
    : Schema.decodeUnknownSync(SlotSelection)(value).active.target;
}

/** The primary's candidate and draining boot share the same physical fleet limit. */
export async function physicalPrimaryTargets(storage: SlotStorage): Promise<SlotTarget[]> {
  const value = await storage.get(slotSelectionKey);
  if (value === undefined) return [];
  const selection = Schema.decodeUnknownSync(SlotSelection)(value);
  return [selection.active, selection.candidate, selection.draining]
    .filter((slot) => slot !== undefined && slot.target.instanceId !== slot.target.controllerId)
    .map((slot) => slot!.target);
}
