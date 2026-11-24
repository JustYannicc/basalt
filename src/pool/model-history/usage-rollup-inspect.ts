import type {
  UsageRollupAutoState,
  UsageRollupAutoStop,
  UsageRollupSlowPhase,
  UsageRollupStuck,
} from "./usage-rollup-auto.ts";

const hex16 = /^[0-9a-f]{16}$/;
// Only a strict UTC timestamp passes: a lenient date parse would let free text through.
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;
export const iso = (value: unknown) =>
  typeof value === "string" && isoPattern.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null;
export const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const milliseconds = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 10) / 10
    : null;
const stopNames = {
  complete: true,
  budget: true,
  wal: true,
  lock: true,
  slow_hour: true,
  slow_hold: true,
  slow_read: true,
  changing: true,
  ceiling: true,
  error: true,
  handover: true,
  not_applied: true,
  stuck: true,
  waiting: true,
  ready: true,
} satisfies Record<UsageRollupAutoStop, true>;
const stops = new Set<string>(Object.keys(stopNames));
const reasonNames = { slow: true, lock: true, error: true } satisfies Record<
  UsageRollupStuck["reason"],
  true
>;
const reasons = new Set<string>(Object.keys(reasonNames));
const phaseNames = { read: true, apply: true } satisfies Record<UsageRollupSlowPhase, true>;
const phases = new Set<string>(Object.keys(phaseNames));

/**
 * The backfill's state as the fleet lane's inspect shows it: only what the object already stores,
 * closed and with 16-hex history pool ids only, so reading it touches no database.
 */
export function usageRollupInspect(state: UsageRollupAutoState) {
  return {
    rollup: state.rollup === "v16" ? ("v16" as const) : ("v15" as const),
    lastTickAt: iso(state.lastTickAt),
    lastStop:
      typeof state.lastStop === "string" && stops.has(state.lastStop) ? state.lastStop : null,
    pausedUntil: iso(state.pausedUntil),
    lastHour: iso(state.lastHour),
    lastHourPhase:
      typeof state.lastHourPhase === "string" && phases.has(state.lastHourPhase)
        ? state.lastHourPhase
        : null,
    lastHourReadMs: milliseconds(state.lastHourReadMs),
    pools: count(state.pools),
    pendingHours: count(state.pendingHours),
    totalPendingHours: count(state.totalPendingHours),
    stuck: closedStuck(state.stuck),
  };
}

/** A tick's stuck pools, closed: 16-hex pool ids, a known reason, strict times. */
export function closedStuck(
  stuck:
    | readonly { pool?: unknown; reason?: unknown; hour?: unknown; retryAt?: unknown }[]
    | undefined,
) {
  return (Array.isArray(stuck) ? stuck : []).flatMap((entry) =>
    typeof entry?.pool === "string" && (entry.pool === "" || hex16.test(entry.pool))
      ? [
          {
            // A tick stuck before it reached any pool names none.
            pool: entry.pool === "" ? null : entry.pool,
            reason:
              typeof entry.reason === "string" && reasons.has(entry.reason)
                ? (entry.reason as UsageRollupStuck["reason"])
                : null,
            hour: iso(entry.hour),
            retryAt: iso(entry.retryAt),
          },
        ]
      : [],
  );
}
