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
 * Each pool's own progress, named by its place among the pools in the order of their history ids,
 * never by the id: its pending blocks and hours, and its hours in their slow wait with when each wait
 * ends, how many times in a row it ran out its limit, how many of a stuck hour's longer retries it
 * has had, and whether it was given up. The place matches the slow log line's.
 */
function byPool(state: CaptureHoursAutoState) {
  const entries = (Array.isArray(state.byPool) ? state.byPool : []).filter(
    (entry) => typeof entry?.pool === "string" && hex16.test(entry.pool),
  );
  const slow = Array.isArray(state.slow) ? state.slow : [];
  const stops = Array.isArray(state.lastSlow) ? state.lastSlow : [];
  const lastSlow = (pool: string) => {
    const stop = stops.find((entry) => entry?.pool === pool);
    return stop && iso(stop.hour) !== null
      ? {
          at: iso(stop.at),
          hour: iso(stop.hour)!,
          block: iso(stop.block),
          limit: stop.limit === "count" || stop.limit === "read" ? stop.limit : null,
          elapsedMs: milliseconds(stop.elapsedMs),
          repeat: count(stop.repeat),
        }
      : null;
  };
  return [...entries]
    .sort((a, b) => (a.pool < b.pool ? -1 : 1))
    .map((entry, n) => ({
      ordinal: n + 1,
      pendingBlocks: count(entry.pendingBlocks),
      pendingHours: count(entry.pendingHours),
      slow: slow
        .filter((wait) => wait?.pool === entry.pool && iso(wait.hour) !== null)
        .map((wait) => ({
          hour: iso(wait.hour)!,
          until: iso(wait.until),
          repeat: count(wait.count),
          retries: count(wait.retries ?? 0),
          gaveUp: wait.gaveUp === true,
        })),
      lastSlow: lastSlow(entry.pool),
    }));
}

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
    planMs: milliseconds(state.planMs),
    byPool: byPool(state),
    recountPosition:
      typeof state.recountPosition?.pool === "string" &&
      hex16.test(state.recountPosition.pool) &&
      iso(state.recountPosition.block)
        ? { pool: state.recountPosition.pool, block: iso(state.recountPosition.block)! }
        : null,
  };
}
