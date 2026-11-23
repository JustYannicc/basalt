import type { HistoryDatabase } from "./schema.ts";
import {
  planUsageRollup,
  runUsageRollup,
  usageRollupHourLimitMs,
  usageRollupWalPerCall,
} from "./usage-rollup-backfill.ts";

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
  /** After any stop other than its own time or WAL budget, the next tick waits this long. */
  readonly pauseMs: number;
  /** The same pool stopping slow on the same hour this many times in a row is stuck. */
  readonly slowAfter: number;
  /** The same pool stopping on a lock or an error this many times in a row is stuck. */
  readonly failingAfter: number;
  /** A stuck pool is tried once more after this long; until then the tick skips it. */
  readonly retryStuckMs: number;
  readonly hourLimitMs: number;
}
export const usageRollupAutoBounds: UsageRollupAutoBounds = {
  sessions: 2,
  sessionMs: 12_000,
  sessionWalBytes: 16 * 1024 * 1024,
  hourMs: 300_000,
  hourWalBytes: 256 * 1024 * 1024,
  pauseMs: 3_600_000,
  slowAfter: 3,
  failingAfter: 6,
  retryStuckMs: 86_400_000,
  hourLimitMs: usageRollupHourLimitMs,
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
  | "ready";

type StuckReason = "slow" | "lock" | "error";
export interface UsageRollupStuck {
  readonly pool: string;
  readonly reason: StuckReason;
  readonly hour?: string;
  readonly retryAt: string;
}

export interface UsageRollupAutoState {
  readonly lastTickAt?: string;
  readonly lastStop?: UsageRollupAutoStop;
  readonly lastHour?: string;
  /** Pools not ready yet, and the hours left in the pool the last session worked on. */
  readonly pools?: number;
  readonly pendingHours?: number;
  readonly pausedUntil?: string;
  /** Pools the tick skips until their hour is done, their pool is ready, or their retry is due. */
  readonly stuck?: readonly UsageRollupStuck[];
  readonly repeat?: {
    readonly pool: string;
    readonly reason: StuckReason;
    readonly hour?: string;
    readonly count: number;
  };
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

type Outcome =
  | { kind: "not_applied" | "ready"; stuck: readonly UsageRollupStuck[] }
  | {
      kind: "ran";
      pool: string;
      pools: number;
      stuck: readonly UsageRollupStuck[];
      result: Awaited<ReturnType<typeof runUsageRollup>>;
    };

const notApplied = "The usage rollup migration is not applied";
const hourMs = 3_600_000;

/** Stuck entries whose pool became ready, or whose hour is now done, are cleared. */
async function unresolved(db: HistoryDatabase, stuck: readonly UsageRollupStuck[]) {
  if (!stuck.length) return stuck;
  const done = await db.query(
    `SELECT s.pool, s.hour FROM jsonb_to_recordset($1::jsonb) AS s(pool text, hour text)
    WHERE EXISTS (SELECT 1 FROM basalt_model_usage_ready r WHERE r.pool=s.pool)
      OR (s.hour IS NOT NULL AND EXISTS (SELECT 1 FROM basalt_model_usage_hours h
        WHERE h.pool=s.pool AND h.hour=s.hour::timestamptz))`,
    [JSON.stringify(stuck.map(({ pool, hour }) => ({ pool, hour: hour ?? null })))],
  );
  const cleared = new Set(done.rows.map((row) => `${String(row.pool)}|${row.hour ?? ""}`));
  return stuck.filter((entry) => !cleared.has(`${entry.pool}|${entry.hour ?? ""}`));
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
  ) => [
    ...list.filter((entry) => entry.pool !== pool),
    {
      pool,
      reason,
      ...(hour ? { hour } : {}),
      retryAt: new Date(now() + bounds.retryStuckMs).toISOString(),
    },
  ];
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
        const stuck = await unresolved(db, stuckBefore);
        let planned: Awaited<ReturnType<typeof planUsageRollup>>;
        try {
          planned = await plan(db);
        } catch (error) {
          if (error instanceof Error && error.message === notApplied)
            return { kind: "not_applied", stuck };
          throw error;
        }
        // One pool at a time: the first that is neither ready nor stuck, or whose retry is due.
        const skipped = new Set(
          stuck.filter((entry) => Date.parse(entry.retryAt) > now()).map((entry) => entry.pool),
        );
        const open = planned.plan.pools.filter((item) => !skipped.has(item.pool));
        const next = open[0];
        if (!next) return { kind: "ready", stuck };
        working = next.pool;
        const result = await run(
          db,
          { pools: [next] },
          Math.min(bounds.sessionMs, msLeft),
          now,
          Math.min(bounds.sessionWalBytes, walLeft, usageRollupWalPerCall),
          bounds.hourLimitMs,
          stopped,
        );
        return { kind: "ran", pool: next.pool, pools: open.length, stuck, result };
      });
    } catch (error) {
      console.error("POOL_USAGE_ROLLUP_TICK_FAILED", {
        failure: error instanceof Error ? error.name : "unknown",
      });
      const spent = { at, ms: now() - at, walBytes: 0 };
      const same = state.repeat?.reason === "error" && state.repeat.pool === (working ?? "");
      const count = same ? state.repeat!.count + 1 : 1;
      const stuck = working !== undefined && count >= bounds.failingAfter;
      if (stuck) console.error("POOL_USAGE_ROLLUP_STUCK", { reason: "error" });
      await save({
        ...state,
        sessions: [...recent, spent],
        lastStop: "error",
        lastHour: undefined,
        repeat: { pool: working ?? "", reason: "error", count },
        ...(stuck ? { stuck: stuckWith(stuckBefore, working!, "error", undefined) } : {}),
        pausedUntil: pause(),
      });
      break;
    }
    const spent = {
      at,
      ms: now() - at,
      walBytes: outcome.kind === "ran" ? Math.max(0, outcome.result.walBytes) : 0,
    };
    const base = { ...state, sessions: [...recent, spent], stuck: outcome.stuck };
    if (outcome.kind !== "ran") {
      await save({
        ...base,
        lastStop: outcome.kind,
        lastHour: undefined,
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
    const cleared = (ran.stuck ?? []).filter((entry) => entry.pool !== outcome.pool);
    if (result.status === "complete") {
      // The next pool starts on a later tick, so two pools never share one.
      await save({
        ...ran,
        lastStop: "complete",
        lastHour: undefined,
        pools: outcome.pools - 1,
        repeat: undefined,
        stuck: cleared,
      });
      break;
    }
    const halted = result.stopped ?? "budget";
    if (halted === "budget" || halted === "wal") {
      await save({
        ...ran,
        lastStop: stopped() ? "handover" : halted,
        lastHour: undefined,
        repeat: undefined,
        stuck: cleared,
      });
      continue;
    }
    const reason: StuckReason = halted === "lock" ? "lock" : "slow";
    const hour = reason === "slow" ? result.slowHour : undefined;
    const same =
      state.repeat?.pool === outcome.pool &&
      state.repeat.reason === reason &&
      state.repeat.hour === hour;
    const count = same ? state.repeat!.count + 1 : 1;
    const stuck = count >= (reason === "slow" ? bounds.slowAfter : bounds.failingAfter);
    if (stuck) console.error("POOL_USAGE_ROLLUP_STUCK", { reason, ...(hour ? { hour } : {}) });
    await save({
      ...ran,
      lastStop: halted,
      lastHour: hour,
      repeat: { pool: outcome.pool, reason, ...(hour ? { hour } : {}), count },
      ...(stuck ? { stuck: stuckWith(ran.stuck ?? [], outcome.pool, reason, hour) } : {}),
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
