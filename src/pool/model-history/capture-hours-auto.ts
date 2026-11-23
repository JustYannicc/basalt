import type { HistoryDatabase } from "./schema.ts";
import { captureHoursCountLimitMs, countCaptureHour } from "./capture-hours-count.ts";
import {
  countedHours,
  planCaptureHours,
  stalestCapture,
  stalestHours,
} from "./capture-hours-plan.ts";

export { captureHoursInspect } from "./capture-hours-inspect.ts";

/**
 * The pool counts each of its settled hours' Home usage rows itself: each model-history pass ends,
 * after the usage rollup's tick, with one tick of at most two bounded sessions of its own, each
 * counting pending hours oldest first, one short transaction per hour, then recounting the hours
 * counted longest ago. Its state is stored apart from the rollup's.
 */
export const captureHoursAutoKey = "capture-hours-auto-v1";

export interface CaptureHoursAutoBounds {
  readonly sessions: number;
  readonly sessionMs: number;
  /** Counting time in any 60 minutes of wall time, across ticks. */
  readonly hourMs: number;
  /** After a lock or an error the tick waits this long. */
  readonly pauseMs: number;
  /** A pool whose count of an hour ran out its limit waits this long; the others go on. */
  readonly slowPauseMs: number;
  /** The same pool-hour slow this many times in a row is stuck; it is retried after each wait. */
  readonly slowAfter: number;
  /** The same pool stopping on a lock or an error this many times in a row is stuck. */
  readonly failingAfter: number;
  readonly countLimitMs: number;
  /** Settled hours recounted per tick, the ones counted longest ago, once nothing is pending. */
  readonly recount: number;
}
export const captureHoursAutoBounds: CaptureHoursAutoBounds = {
  sessions: 2,
  sessionMs: 12_000,
  hourMs: 120_000,
  pauseMs: 3_600_000,
  slowPauseMs: 600_000,
  slowAfter: 3,
  failingAfter: 6,
  countLimitMs: captureHoursCountLimitMs,
  recount: 24,
};

export type CaptureHoursAutoStop =
  | "complete"
  | "budget"
  | "lock"
  /** A count ran out its own limit and every pool left is waiting after one. */
  | "slow"
  | "ceiling"
  | "error"
  | "handover"
  | "not_applied"
  /** Every pool with pending hours is in its slow wait. */
  | "waiting";

type StuckReason = "slow" | "lock" | "error";
export interface CaptureHoursStuck {
  /** A pool's own 16-hex history id, or "" for a tick that fails before it reaches any pool. */
  readonly pool: string;
  readonly reason: StuckReason;
  readonly hour?: string;
  readonly retryAt: string;
}
export interface CaptureHoursSlowWait {
  readonly pool: string;
  readonly hour: string;
  /** Slow counts of this hour in a row. */
  readonly count: number;
  readonly until: string;
}

export interface CaptureHoursAutoState {
  readonly lastTickAt?: string;
  readonly lastStop?: CaptureHoursAutoStop;
  /** The hour that last stopped a session, until it is counted, with its count's time limit. */
  readonly lastHour?: string;
  readonly lastHourReadMs?: number;
  /** Pools with pending hours, the hours left in the last pool worked on, and across pools. */
  readonly pools?: number;
  readonly pendingHours?: number;
  readonly totalPendingHours?: number;
  /** The oldest time any settled count was taken: how far the rolling recount lags. */
  readonly stalestCheckedAt?: string;
  readonly pausedUntil?: string;
  readonly stuck?: readonly CaptureHoursStuck[];
  readonly repeat?: {
    readonly pool: string;
    readonly reason: "lock" | "error";
    readonly count: number;
  };
  readonly slow?: readonly CaptureHoursSlowWait[];
  /** The sessions of the last 60 minutes, for the sliding hourly ceiling. */
  readonly sessions?: readonly { readonly at: number; readonly ms: number }[];
}

interface AutoStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
type Session = <T>(work: (db: HistoryDatabase) => Promise<T>) => Promise<T>;
const hourMs = 3_600_000;

/** One tick. Returns the state it stored; never throws for a counting failure, only logs it. */
export async function captureHoursTick(
  storage: AutoStorage,
  session: Session,
  options: {
    now?: () => number;
    bounds?: Partial<CaptureHoursAutoBounds>;
    /** True once a code handover starts: the tick ends before its next hour. */
    stopped?: () => boolean;
  } = {},
): Promise<CaptureHoursAutoState> {
  const now = options.now ?? (() => Date.now());
  const bounds = { ...captureHoursAutoBounds, ...options.bounds };
  const stopped = options.stopped ?? (() => false);
  const previous = (await storage.get<CaptureHoursAutoState>(captureHoursAutoKey)) ?? {};
  const started = now();
  if (previous.pausedUntil && Date.parse(previous.pausedUntil) > started) return previous;
  let state: CaptureHoursAutoState = {
    ...previous,
    pausedUntil: undefined,
    lastTickAt: new Date(started).toISOString(),
  };
  const save = async (next: CaptureHoursAutoState) => {
    state = next;
    await storage.put(captureHoursAutoKey, state);
  };
  const stuckWith = (
    list: readonly CaptureHoursStuck[],
    entry: CaptureHoursStuck,
  ): CaptureHoursStuck[] => [...list.filter((item) => item.pool !== entry.pool), entry];
  // A failure counts against its pool; six in a row, or a stuck pool failing again, is stuck.
  const failed = async (
    reason: "lock" | "error",
    pool: string,
    base: CaptureHoursAutoState,
    hour?: string,
  ) => {
    const same = base.repeat?.reason === reason && base.repeat.pool === pool;
    const count = same ? base.repeat!.count + 1 : 1;
    const pausedUntil = new Date(now() + bounds.pauseMs).toISOString();
    const stuck = count >= bounds.failingAfter;
    if (count === bounds.failingAfter) console.error("POOL_CAPTURE_HOURS_STUCK", { reason });
    await save({
      ...base,
      lastStop: reason,
      ...(hour ? { lastHour: hour, lastHourReadMs: undefined } : {}),
      repeat: { pool, reason, count },
      ...(stuck
        ? { stuck: stuckWith(base.stuck ?? [], { pool, reason, retryAt: pausedUntil }) }
        : {}),
      pausedUntil,
    });
  };
  let recounted = false;
  for (let index = 0; index < bounds.sessions; index++) {
    if (stopped()) {
      await save({ ...state, lastStop: "handover" });
      break;
    }
    const at = now();
    const recent = (state.sessions ?? []).filter((entry) => at - entry.at < hourMs);
    const msLeft = bounds.hourMs - recent.reduce((sum, entry) => sum + entry.ms, 0);
    if (msLeft <= 0) {
      await save({ ...state, sessions: recent, lastStop: "ceiling" });
      break;
    }
    const budget = Math.min(bounds.sessionMs, msLeft);
    const left = () => budget - (now() - at);
    let working = "";
    // Every change the session makes is kept here, so a failure mid-session keeps its progress.
    let next: CaptureHoursAutoState = { ...state };
    let stop: CaptureHoursAutoStop | undefined;
    let stopHour: string | undefined;
    try {
      stop = await session(async (db) => {
        const plan = await planCaptureHours(db);
        if (!plan) return "not_applied";
        const { pools, plannedAt } = plan;
        // The tick reached its database and plan, so it is no longer failing as a whole.
        const done = await countedHours(db, [...(next.stuck ?? []), ...(next.slow ?? [])]);
        const open = (entry: { pool: string; hour?: string }) =>
          !entry.hour || !done.has(`${entry.pool}|${entry.hour}`);
        next = {
          ...next,
          stuck: (next.stuck ?? []).filter((entry) => entry.pool !== "" && open(entry)),
          slow: (next.slow ?? []).filter(open),
          repeat: next.repeat?.pool === "" ? undefined : next.repeat,
          stalestCheckedAt:
            (await stalestCapture(db).catch(() => undefined)) ?? next.stalestCheckedAt,
        };
        const pending = new Map(pools.map((pool) => [pool.pool, pool.pending]));
        const tally = () => {
          const left = [...pending.values()];
          next = {
            ...next,
            pools: left.filter((n) => n > 0).length,
            totalPendingHours: left.reduce((sum, n) => sum + n, 0),
          };
        };
        tally();
        const waiting = () =>
          new Set(
            (next.slow ?? [])
              .filter((entry) => Date.parse(entry.until) > now())
              .map((entry) => entry.pool),
          );
        let slowed = false;
        // One hour, counted. Returns the session's stop, or undefined to go on with its pool, or
        // "next" to leave the pool for this session.
        const count = async (pool: string, hour: string) => {
          if (stopped()) return "handover" as const;
          if (left() <= 0) return "budget" as const;
          working = pool;
          const result = await countCaptureHour(db, pool, hour, left, bounds.countLimitMs);
          if (result.kind === "budget") return "budget" as const;
          if (result.kind === "lock") {
            stopHour = hour;
            return "lock" as const;
          }
          if (result.kind === "slow") {
            const before = (next.slow ?? []).find((entry) => entry.pool === pool);
            const repeats = before?.hour === hour ? before.count + 1 : 1;
            const until = new Date(now() + bounds.slowPauseMs).toISOString();
            // Loud once, when the pool first becomes stuck; its retries after each wait stay quiet.
            if (repeats === bounds.slowAfter)
              console.error("POOL_CAPTURE_HOURS_STUCK", { reason: "slow", hour });
            next = {
              ...next,
              lastHour: hour,
              lastHourReadMs: result.readMs,
              slow: [
                ...(next.slow ?? []).filter((entry) => entry.pool !== pool),
                { pool, hour, count: repeats, until },
              ],
              ...(repeats >= bounds.slowAfter
                ? {
                    stuck: stuckWith(next.stuck ?? [], {
                      pool,
                      reason: "slow",
                      hour,
                      retryAt: until,
                    }),
                  }
                : {}),
            };
            slowed = true;
            return "next" as const;
          }
          // Counted: the pool is no longer failing, and its slow or stuck hour is done.
          const cleared = (entry: { pool: string; hour?: string }) =>
            entry.pool !== pool || (entry.hour !== undefined && entry.hour !== hour);
          next = {
            ...next,
            // The hour that last stopped a session is named until it is counted.
            ...(next.lastHour === hour ? { lastHour: undefined, lastHourReadMs: undefined } : {}),
            stuck: (next.stuck ?? []).filter(cleared),
            slow: (next.slow ?? []).filter(cleared),
            repeat: next.repeat?.pool === pool ? undefined : next.repeat,
          };
          return undefined;
        };
        for (const pool of pools) {
          if (waiting().has(pool.pool)) continue;
          for (const hour of pool.hours) {
            const stop = await count(pool.pool, hour);
            if (stop === "next") break;
            if (stop) return stop;
            pending.set(pool.pool, Math.max(0, pending.get(pool.pool)! - 1));
            next = { ...next, pendingHours: pending.get(pool.pool) };
            tally();
          }
        }
        const held = waiting();
        // Hours a plan did not list, beyond its cap, are left for the next session.
        if (pools.some((pool) => pending.get(pool.pool)! > 0 && !held.has(pool.pool)))
          return "budget";
        if (!recounted) {
          const pools = [...pending.keys()].filter((pool) => !held.has(pool));
          for (const entry of await stalestHours(db, pools, bounds.recount, plannedAt)) {
            if (waiting().has(entry.pool)) continue;
            const stop = await count(entry.pool, entry.hour);
            if (stop && stop !== "next") return stop;
          }
          recounted = true;
        }
        if ([...pending].some(([pool, n]) => n > 0 && held.has(pool)))
          return slowed ? "slow" : "waiting";
        return "complete";
      });
    } catch (error) {
      console.error("POOL_CAPTURE_HOURS_TICK_FAILED", {
        failure: error instanceof Error ? error.name : "unknown",
      });
      await failed("error", working, {
        ...next,
        sessions: [...recent, { at, ms: now() - at }],
      });
      break;
    }
    const base = { ...next, sessions: [...recent, { at, ms: now() - at }] };
    if (stop === "lock") {
      await failed("lock", working, base, stopHour);
      break;
    }
    await save({ ...base, lastStop: stop === "budget" && stopped() ? "handover" : stop });
    if (stop !== "budget") break;
  }
  return state;
}

export async function captureHoursAutoState(storage: AutoStorage): Promise<CaptureHoursAutoState> {
  return (await storage.get<CaptureHoursAutoState>(captureHoursAutoKey)) ?? {};
}

/** The pools whose counting is stuck, which the minute check reports as a reliability reason. */
export const captureHoursStuckPools = (state: CaptureHoursAutoState) =>
  [...new Set((state.stuck ?? []).map((entry) => entry.pool))].sort();
