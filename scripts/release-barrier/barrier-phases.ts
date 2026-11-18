/** Each phase a barrier receipt records; the release coverage gate enumerates them from here. */
export const barrierPhases = [
  "upload",
  "admitted",
  "schema",
  "baseline",
  "activation",
  "container-activation",
  "complete",
] as const;
export type BarrierPhase = (typeof barrierPhases)[number];
