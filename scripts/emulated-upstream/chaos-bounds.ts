/**
 * Profile b's bounds, shared by the Worker's control and the profile run's guard, which runs before
 * any credential and imports nothing else. aimock reads a rate only as a plain decimal and ignores
 * any other spelling, `1e-3` included.
 */
const plainDecimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;
export const maxLatencyMs = 30_000;

/** A 429 share aimock reads as sent: as a number, the way JSON spells it, a plain decimal to 1. */
export const rateAccepted = (rate: unknown): rate is number =>
  typeof rate === "number" && plainDecimal.test(String(rate)) && rate <= 1;

/** A first-byte latency the control takes: whole milliseconds from 0 to its maximum. */
export const latencyAccepted = (latency: unknown): latency is number =>
  typeof latency === "number" &&
  Number.isSafeInteger(latency) &&
  latency >= 0 &&
  latency <= maxLatencyMs;

/**
 * Profile b's two faults from a run's typed inputs, or undefined unless the control takes both
 * exactly as typed: a share whose number JSON would spell otherwise, `0.0000009` as `9e-7`, is
 * refused here rather than by the control after the run's go is spent.
 */
export function chaosFromText(share: string, latency: string) {
  if (!plainDecimal.test(share) || !/^(?:0|[1-9]\d*)$/u.test(latency)) return undefined;
  const rateLimitRate = Number(share);
  const latencyMs = Number(latency);
  if (!rateAccepted(rateLimitRate) || !latencyAccepted(latencyMs)) return undefined;
  return { rateLimitRate, latencyMs };
}
