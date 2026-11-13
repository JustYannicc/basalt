export const modelDrainProtocol = "basalt.model-drain.v1";

/** Passive payload view; validating receipts and advancing credits belongs to ModelDrain. */
export function modelDrainPayload(data: unknown, direction: "input" | "output") {
  if (!(data instanceof ArrayBuffer)) return undefined;
  const frame = new Uint8Array(data);
  const offset = direction === "input" ? 5 : 1;
  if ((frame[0] !== 0 && frame[0] !== 1) || frame.length < offset) return undefined;
  return frame.subarray(offset);
}
