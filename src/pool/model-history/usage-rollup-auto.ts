import type { HistoryDatabase } from "./schema.ts";
import {
  planUsageRollup,
  runUsageRollup,
  usageRollupHourLimitMs,
  usageRollupReadLimitMs,
  usageRollupWalPerCall,
  type UsageRollupPlan,
} from "./usage-rollup-backfill.ts";
import type { UsageRollupSlowPhase } from "./usage-rollup-hour.ts";

/**
 * The pool backfills its own usage rollup: each model-history pass ends with one tick of at most
 * two bounded sessions, each recomputing one pool's hours with the operator backfill's own stops
 * (the hour limit, the hold limit, the try-lock that yields to writers, the WAL budget).
 */
export const usageRollupAutoKey = "usage-rollup-auto-v1";
export interface UsageRollupAutoBounds {
  readonly sessions: number;
  readonly sessionMs: number;
  readonly sessionWalBytes: number;
  /** Backfill time and write-ahead log in any 60 minutes of wall time, across ticks. */
  readonly hourMs: number;
  readonly hourWalBytes: number;
  /** After a lock, an error or a long hold, the next tick waits this long. */
  readonly pauseMs: number;
  /**
   * A pool that stopped on a slow hour waits this long; meanwhile the tick goes on with the other
   * pools, so one dense hour never delays them.
   */
  readonly slowPauseMs: number;
  /**
   * The same pool stopping slow on the same hour this many times is stuck, and keeps being retried
   * after each slow wait until the hour fits.
   */
  readonly slowAfter: number;
  /** The same pool stopping on a lock or an error this many times in a row is stuck. */
  readonly failingAfter: number;
  /** A pool stuck on a lock, an error or a long hold is tried once more after this long. */
  readonly retryStuckMs: number;
  readonly hourLimitMs: number;
  readonly readLimitMs: number;
}
export const usageRollupAutoBounds: UsageRollupAutoBounds = {
  sessions: 2,
  sessionMs: 12_000,
  sessionWalBytes: 16 * 1024 * 1024,
  hourMs: 300_000,
  hourWalBytes: 256 * 1024 * 1024,
  pauseMs: 3_600_000,
  slowPauseMs: 600_000,
  slowAfter: 3,
  failingAfter: 6,
  retryStuckMs: 86_400_000,
  hourLimitMs: usageRollupHourLimitMs,
  readLimitMs: usageRollupReadLimitMs,
};

export type UsageRollupAutoStop =
  | "complete"
  | "budget"
  | "wal"
  | "lock"
  | "slow_hour"
  | "slow_hold"
  | "ceiling"
  | "error"
  | "handover"
  | "not_applied"
  | "stuck"
  /** Every pool left is in its slow wait. */
  | "waiting"
  | "ready";

type StuckReason = "slow" | "lock" | "error";
export interface UsageRollupStuck {
  /** A pool's own 16-hex history id, or "" for a tick that fails before it reaches any pool. */
  readonly pool: string;
  readonly reason: StuckReason;
  readonly hour?: string;
  readonly retryAt: string;
}

export interface UsageRollupSlowWait {
  readonly pool: string;
  readonly hour: string;
  /** Slow stops on this hour since the pool last got past it. */
  readonly count: number;
  readonly until: string;
}

export interface UsageRollupAutoState {
  readonly lastTickAt?: string;
  readonly lastStop?: UsageRollupAutoStop;
  readonly lastHour?: string;
  /** For a slow hour: where its last attempt was cancelled, and its last warming read's time. */
  readonly lastHourPhase?: UsageRollupSlowPhase;
  readonly lastHourReadMs?: number;
  /** Pools not ready yet, and the hours left in the pool the last session worked on. */
  readonly pools?: number;
  readonly pendingHours?: number;
  /** The hours left across every pool not ready yet. */
  readonly totalPendingHours?: number;
  readonly pausedUntil?: string;
  /** Pools the tick skips until their hour is done, their pool is ready, or their retry is due. */
  readonly stuck?: readonly UsageRollupStuck[];
  readonly repeat?: {
    readonly pool: string;
    readonly reason: StuckReason;
    readonly hour?: string;
    readonly count: number;
  };
  /** Pools waiting after a slow hour, until that hour is done or their pool is ready. */
  readonly slow?: readonly UsageRollupSlowWait[];
  /** The sessions of the last 60 minutes, for the sliding hourly ceilings. */
  readonly sessions?: readonly {
    readonly at: number;
    readonly ms: number;
    readonly walBytes: number;
  }[];
}

interface AutoStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

type Session = <T>(work: (db: HistoryDatabase) => Promise<T>) => Promise<T>;

interface Held {
  stuck: readonly UsageRollupStuck[];
  slow: readonly UsageRollupSlowWait[];
  totalPendingHours?: number;
}
type Outcome =
  | ({ kind: "not_applied" | "ready" | "stuck" | "waiting" } & Held)
  | ({
      kind: "ran";
      pool: string;
      pools: number;
      result: Awaited<ReturnType<typeof runUsageRollup>>;
    } & Held);

const notApplied = "The usage rollup migration is not applied";
const hourMs = 3_600_000;

/** Stuck and slow entries whose pool became ready, or whose hour is now done, are cleared. */
async function unresolved(
  db: HistoryDatabase,
  stuck: readonly UsageRollupStuck[],
  slow: readonly UsageRollupSlowWait[],
) {
  const entries = [...stuck, ...slow];
  if (!entries.length) return { stuck, slow };
  const done = await db.query(
    `SELECT s.pool, s.hour FROM jsonb_to_recordset($1::jsonb) AS s(pool text, hour text)
    WHERE EXISTS (SELECT 1 FROM basalt_model_usage_ready r WHERE r.pool=s.pool)
      OR (s.hour IS NOT NULL AND EXISTS (SELECT 1 FROM basalt_model_usage_hours h
        WHERE h.pool=s.pool AND h.hour=s.hour::timestamptz))`,
    [JSON.stringify(entries.map(({ pool, hour }) => ({ pool, hour: hour ?? null })))],
  );
  const cleared = new Set(done.rows.map((row) => `${String(row.pool)}|${row.hour ?? ""}`));
  const open = (entry: { pool: string; hour?: string }) =>
    !cleared.has(`${entry.pool}|${entry.hour ?? ""}`);
  return { stuck: stuck.filter(open), slow: slow.filter(open) };
}

/** The hours left across the plan's pools, in one read of the done-markers' primary key. */
async function pendingAcross(db: HistoryDatabase, plan: UsageRollupPlan) {
  if (!plan.pools.length) return 0;
  const total = await db.query(
    `SELECT coalesce(sum(greatest(p.days * 24 - (SELECT count(*) FROM basalt_model_usage_hours h
        WHERE h.pool=p.pool AND h.hour >= p.since AND h.hour < p.until), 0)), 0)::int AS n
    FROM jsonb_to_recordset($1::jsonb) AS p(pool text, since timestamptz, until timestamptz,
      days int)`,
    [
      JSON.stringify(
        plan.pools.map(({ pool, from, to, days }) => ({ pool, since: from, until: to, days })),
      ),
    ],
  );
  return Number(total.rows[0]?.n ?? 0);
}

/** One tick. Returns the state it stored; never throws for a backfill failure, only logs it. */
export async function usageRollupTick(
  storage: AutoStorage,
  session: Session,
  options: {
    now?: () => number;
    bounds?: Partial<UsageRollupAutoBounds>;
    /** True once a code handover starts: the tick ends after the hour in flight. */
    stopped?: () => boolean;
    plan?: typeof planUsageRollup;
    run?: typeof runUsageRollup;
  } = {},
): Promise<UsageRollupAutoState> {
  const now = options.now ?? (() => Date.now());
  const bounds = { ...usageRollupAutoBounds, ...options.bounds };
  const stopped = options.stopped ?? (() => false);
  const plan = options.plan ?? planUsageRollup;
  const run = options.run ?? runUsageRollup;
  const previous = (await storage.get<UsageRollupAutoState>(usageRollupAutoKey)) ?? {};
  const started = now();
  if (previous.pausedUntil && Date.parse(previous.pausedUntil) > started) return previous;
  let state: UsageRollupAutoState = {
    ...previous,
    pausedUntil: undefined,
    lastTickAt: new Date(started).toISOString(),
  };
  // Stored after every session, so a reset mid-tick forgets at most the session it cut short.
  const save = async (next: UsageRollupAutoState) => {
    state = next;
    await storage.put(usageRollupAutoKey, state);
  };
  const pause = () => new Date(now() + bounds.pauseMs).toISOString();
  const stuckWith = (
    list: readonly UsageRollupStuck[],
    pool: string,
    reason: StuckReason,
    hour: string | undefined,
    retryAt = new Date(now() + bounds.retryStuckMs).toISOString(),
  ) => [
    ...list.filter((entry) => entry.pool !== pool),
    { pool, reason, ...(hour ? { hour } : {}), retryAt },
  ];
  // A pool stuck on a slow hour is retried after each slow wait; every other stuck pool, daily.
  const daily = (entry: UsageRollupStuck) => !(entry.reason === "slow" && entry.hour);
  const noSlowHour = { lastHour: undefined, lastHourPhase: undefined, lastHourReadMs: undefined };
  for (let index = 0; index < bounds.sessions; index++) {
    if (stopped()) {
      await save({ ...state, lastStop: "handover" });
      break;
    }
    const at = now();
    const recent = (state.sessions ?? []).filter((entry) => at - entry.at < hourMs);
    const msLeft = bounds.hourMs - recent.reduce((sum, entry) => sum + entry.ms, 0);
    const walLeft = bounds.hourWalBytes - recent.reduce((sum, entry) => sum + entry.walBytes, 0);
    if (msLeft <= 0 || walLeft <= 0) {
      await save({ ...state, sessions: recent, lastStop: "ceiling" });
      break;
    }
    const stuckBefore = state.stuck ?? [];
    let working: string | undefined;
    let outcome: Outcome;
    try {
      outcome = await session(async (db): Promise<Outcome> => {
        const { stuck, slow } = await unresolved(db, stuckBefore, state.slow ?? []);
        let planned: Awaited<ReturnType<typeof planUsageRollup>>;
        try {
          planned = await plan(db);
        } catch (error) {
          if (error instanceof Error && error.message === notApplied)
            return { kind: "not_applied", stuck, slow };
          throw error;
        }
        // One pool at a time: the first that is neither ready, stuck nor waiting after a slow
        // hour, or whose retry is due. A pool stuck on a slow hour is retried after each slow
        // wait, however far out a stored retry says.
        const waiting = new Set(
          slow.filter((entry) => Date.parse(entry.until) > now()).map((entry) => entry.pool),
        );
        const skipped = new Set([
          ...waiting,
          ...stuck
            .filter((entry) => daily(entry) && Date.parse(entry.retryAt) > now())
            .map((entry) => entry.pool),
        ]);
        const open = planned.plan.pools.filter((item) => !skipped.has(item.pool));
        const next = open[0];
        if (!next) {
          const kind = stuck.some((entry) => entry.pool)
            ? "stuck"
            : waiting.size
              ? "waiting"
              : "ready";
          return { kind, stuck, slow, totalPendingHours: await pendingAcross(db, planned.plan) };
        }
        working = next.pool;
        const result = await run(
          db,
          { pools: [next] },
          Math.min(bounds.sessionMs, msLeft),
          now,
          Math.min(bounds.sessionWalBytes, walLeft, usageRollupWalPerCall),
          bounds.hourLimitMs,
          stopped,
          bounds.readLimitMs,
        );
        const totalPendingHours = await pendingAcross(db, planned.plan);
        return {
          kind: "ran",
          pool: next.pool,
          pools: open.length,
          stuck,
          slow,
          result,
          totalPendingHours,
        };
      });
    } catch (error) {
      console.error("POOL_USAGE_ROLLUP_TICK_FAILED", {
        failure: error instanceof Error ? error.name : "unknown",
      });
      const spent = { at, ms: now() - at, walBytes: 0 };
      // A failure before any pool is chosen (the connection, the plan) counts against the tick.
      const pool = working ?? "";
      const same = state.repeat?.reason === "error" && state.repeat.pool === pool;
      const count = same ? state.repeat!.count + 1 : 1;
      const retried = stuckBefore.some((entry) => daily(entry) && entry.pool === pool);
      const stuck = retried || count >= bounds.failingAfter;
      if (stuck) console.error("POOL_USAGE_ROLLUP_STUCK", { reason: "error" });
      await save({
        ...state,
        sessions: [...recent, spent],
        lastStop: "error",
        ...noSlowHour,
        repeat: { pool, reason: "error", count },
        ...(stuck ? { stuck: stuckWith(stuckBefore, pool, "error", undefined) } : {}),
        pausedUntil: pause(),
      });
      break;
    }
    const spent = {
      at,
      ms: now() - at,
      walBytes: outcome.kind === "ran" ? Math.max(0, outcome.result.walBytes) : 0,
    };
    // The session reached the database and its plan, so the tick itself is no longer failing.
    const base = {
      ...state,
      sessions: [...recent, spent],
      stuck: outcome.stuck.filter((entry) => entry.pool !== ""),
      slow: outcome.slow,
      repeat: state.repeat?.pool === "" ? undefined : state.repeat,
      totalPendingHours: outcome.totalPendingHours ?? state.totalPendingHours,
    };
    if (outcome.kind !== "ran") {
      // A pool stuck or waiting is held up by the slow hour the state still names.
      const held = outcome.kind === "stuck" || outcome.kind === "waiting";
      await save({
        ...base,
        lastStop: outcome.kind,
        ...(held ? {} : noSlowHour),
        pools: 0,
        pendingHours: 0,
      });
      break;
    }
    const { result } = outcome;
    const ran = {
      ...base,
      pools: outcome.pools,
      pendingHours: result.pools[0]?.remainingHours ?? 0,
    };
    // Only hours recomputed count as progress: a stop before the first hour (a handover, a
    // budget the hour's ceiling cut to nothing) neither clears the pool nor resets its count.
    const progressed = (result.pools[0]?.recomputedHours ?? 0) > 0;
    // A pool stuck on a slow hour stays stuck until that hour is done, whatever else it got through.
    const cleared = progressed
      ? (ran.stuck ?? []).filter((entry) => entry.pool !== outcome.pool || !daily(entry))
      : ran.stuck;
    const repeat = progressed && ran.repeat?.pool === outcome.pool ? undefined : ran.repeat;
    if (result.status === "complete") {
      // The next pool starts on a later tick, so two pools never share one.
      await save({
        ...ran,
        lastStop: "complete",
        ...noSlowHour,
        pools: outcome.pools - 1,
        repeat,
        stuck: (ran.stuck ?? []).filter((entry) => entry.pool !== outcome.pool),
        slow: (ran.slow ?? []).filter((entry) => entry.pool !== outcome.pool),
      });
      break;
    }
    const halted = result.stopped ?? "budget";
    if (halted === "budget" || halted === "wal") {
      await save({
        ...ran,
        lastStop: stopped() ? "handover" : halted,
        ...noSlowHour,
        repeat,
        stuck: cleared,
      });
      continue;
    }
    if (halted === "slow_hour" && result.slowHour) {
      // Only this pool waits, and only for the slow wait; the next session takes the next pool.
      const hour = result.slowHour;
      const before = (ran.slow ?? []).find((entry) => entry.pool === outcome.pool);
      const count = before?.hour === hour ? before.count + 1 : 1;
      const until = new Date(now() + bounds.slowPauseMs).toISOString();
      const stuck = count >= bounds.slowAfter;
      if (stuck) console.error("POOL_USAGE_ROLLUP_STUCK", { reason: "slow", hour });
      await save({
        ...ran,
        lastStop: halted,
        lastHour: hour,
        lastHourPhase: result.slowPhase,
        lastHourReadMs: result.slowReadMs,
        repeat,
        slow: [
          ...(ran.slow ?? []).filter((entry) => entry.pool !== outcome.pool),
          { pool: outcome.pool, hour, count, until },
        ],
        stuck: stuck ? stuckWith(cleared ?? [], outcome.pool, "slow", hour, until) : cleared,
      });
      continue;
    }
    const reason: StuckReason = halted === "lock" ? "lock" : "slow";
    // A hold past the limit may have committed its hour, so it counts for the pool whichever
    // hour it was.
    const same =
      state.repeat?.pool === outcome.pool &&
      state.repeat.reason === reason &&
      state.repeat.hour === undefined;
    const count = same ? state.repeat!.count + 1 : 1;
    // A stuck pool whose daily retry fails again is stuck again at once.
    const retried = (ran.stuck ?? []).some((entry) => daily(entry) && entry.pool === outcome.pool);
    const stuck = retried || count >= (reason === "slow" ? bounds.slowAfter : bounds.failingAfter);
    if (stuck) console.error("POOL_USAGE_ROLLUP_STUCK", { reason });
    await save({
      ...ran,
      lastStop: halted,
      lastHour: result.slowHour,
      lastHourPhase: undefined,
      lastHourReadMs: undefined,
      repeat: { pool: outcome.pool, reason, count },
      ...(stuck ? { stuck: stuckWith(ran.stuck ?? [], outcome.pool, reason, undefined) } : {}),
      pausedUntil: pause(),
    });
    break;
  }
  return state;
}

export async function usageRollupAutoState(storage: AutoStorage) {
  return (await storage.get<UsageRollupAutoState>(usageRollupAutoKey)) ?? {};
}

/** The pools whose rollup is stuck, which the minute check reports as a reliability reason. */
export const usageRollupStuckPools = (state: UsageRollupAutoState) =>
  [...new Set((state.stuck ?? []).map((entry) => entry.pool))].sort();
