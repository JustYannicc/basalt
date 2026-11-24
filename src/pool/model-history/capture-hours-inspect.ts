import type { CaptureHoursAutoState, CaptureHoursAutoStop } from "./capture-hours-auto.ts";
import { closedStuck, count, iso, milliseconds } from "./usage-rollup-inspect.ts";

const hex16 = /^[0-9a-f]{16}$/;

const stopNames = {
  complete: true,
  budget: true,
  lock: true,
  slow: true,
  ceiling: true,
  error: true,
  handover: true,
  not_applied: true,
  waiting: true,
} satisfies Record<CaptureHoursAutoStop, true>;
const stops = new Set<string>(Object.keys(stopNames));
/**
 * The capture-hour counts' tick as the fleet lane's inspect shows it: only what the object already
 * stores, closed and with 16-hex history pool ids only, so reading it touches no database.
 */
export function captureHoursInspect(state: CaptureHoursAutoState) {
  return {
    lastTickAt: iso(state.lastTickAt),
    lastStop:
      typeof state.lastStop === "string" && stops.has(state.lastStop) ? state.lastStop : null,
    pausedUntil: iso(state.pausedUntil),
    pools: count(state.pools),
    pendingBlocks: count(state.pendingBlocks),
    pendingHours: count(state.pendingHours),
    // The same closed reasons as the rollup's: slow, lock or error.
    stuck: closedStuck(state.stuck),
    lastHour: iso(state.lastHour),
    lastHourReadMs: milliseconds(state.lastHourReadMs),
    stalestCheckedAt: iso(state.stalestCheckedAt),
    recountPosition:
      typeof state.recountPosition?.pool === "string" &&
      hex16.test(state.recountPosition.pool) &&
      iso(state.recountPosition.block)
        ? { pool: state.recountPosition.pool, block: iso(state.recountPosition.block)! }
        : null,
  };
}
