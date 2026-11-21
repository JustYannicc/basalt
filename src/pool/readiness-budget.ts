import { healingReadinessWithinMs } from "./runtime-slots/forced-restart-timing.ts";

/**
 * Readiness waits for the controller object to adopt the uploaded code and then for the controller
 * to heal a running runtime that keeps refusing, at its slowest.
 */
export const readinessWaitMs = healingReadinessWithinMs;
/** Five seconds keep the receipt and teardown outside the wait. */
export const readinessCommandSeconds = (readinessWaitMs + 5_000) / 1_000;
