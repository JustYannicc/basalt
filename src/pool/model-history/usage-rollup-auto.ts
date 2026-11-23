import type { HistoryDatabase } from "./schema.ts";
import {
  planUsageRollup,
  runUsageRollup,
  usageRollupHourLimitMs,
  usageRollupWalPerCall,
} from "./usage-rollup-backfill.ts";
import { usageRollupTargets, type UsageRollupTarget } from "./usage-rollup-targets.ts";

/**
 * The pool backfills its own usage rollup: each model-history pass ends with one tick of at most
 * two bounded sessions, each recomputing one pool's hours with the operator backfill's own stops
 * (the hour limit, the hold limit, the try-lock that yields to writers, the WAL budget).
 * Each rollup keeps its own state; the v16 state exists once a tick has found v16 applied, and
 * from then on it is the one the tick runs and reports.
 */
export const usageRollupAutoKey = "usage-rollup-auto-v1";
export const usagePeopleRollupAutoKey = "usage-rollup-auto-v2";
const autoKeys = { v15: usageRollupAutoKey, v16: usagePeopleRollupAutoKey } as const;
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
  | "stuck"
  | "ready";

type StuckReason = "slow" | "lock" | "error";
export interface UsageRollupStuck {
  /** A pool's own 16-hex history id, or "" for a tick that fails before it reaches any pool. */
  readonly pool: string;
  readonly reason: StuckReason;
  readonly hour?: string;
  readonly retryAt: string;
}

export interface UsageRollupAutoState {
  /** The rollup this state backfills; absent on a v15 state stored before v16. */
  readonly rollup?: UsageRollupTarget;
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
  | { kind: "not_applied" | "ready" | "stuck"; stuck: readonly UsageRollupStuck[] }
  | { kind: "switch"; rollup: UsageRollupTarget }
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
async function unresolved(
  db: HistoryDatabase,
  stuck: readonly UsageRollupStuck[],
  rollup: UsageRollupTarget,
) {
  if (!stuck.length) return stuck;
  const names = usageRollupTargets[rollup];
  const done = await db.query(
    `SELECT s.pool, s.hour FROM jsonb_to_recordset($1::jsonb) AS s(pool text, hour text)
    WHERE EXISTS (SELECT 1 FROM ${names.ready} r WHERE r.pool=s.pool)
      OR (s.hour IS NOT NULL AND EXISTS (SELECT 1 FROM ${names.hours} h
        WHERE h.pool=s.pool AND h.hour=s.hour::timestamptz))`,
    [JSON.stringify(stuck.map(({ pool, hour }) => ({ pool, hour: hour ?? null })))],
  );
  const cleared = new Set(done.rows.map((row) => `${String(row.pool)}|${row.hour ?? ""}`));
  return stuck.filter((entry) => !cleared.has(`${entry.pool}|${entry.hour ?? ""}`));
}

/** The rollup the tick runs and reports: v16 once its state exists, else v15. */
async function activeState(storage: AutoStorage) {
  const people = await storage.get<UsageRollupAutoState>(usagePeopleRollupAutoKey);
  if (people) return { rollup: "v16" as const, state: people };
  return {
    rollup: "v15" as const,
    state: (await storage.get<UsageRollupAutoState>(usageRollupAutoKey)) ?? {},
  };
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
    /** Set on the tick that restarts once v16 is found applied, so it can switch only once. */
    switched?: boolean;
  } = {},
): Promise<UsageRollupAutoState> {
  const now = options.now ?? (() => Date.now());
  const bounds = { ...usageRollupAutoBounds, ...options.bounds };
  const stopped = options.stopped ?? (() => false);
  const plan = options.plan ?? planUsageRollup;
  const run = options.run ?? runUsageRollup;
  const active = await activeState(storage);
  const rollup = active.rollup;
  const key = autoKeys[rollup];
  const previous = active.state;
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
    await storage.put(key, state);
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
        const stuck = await unresolved(db, stuckBefore, rollup);
        let planned: Awaited<ReturnType<typeof planUsageRollup>>;
        try {
          planned = await plan(db);
        } catch (error) {
          if (error instanceof Error && error.message === notApplied)
            return { kind: "not_applied", stuck };
          throw error;
        }
        // The plan names the newest applied rollup. v16 only ever replaces v15: migrations are
        // additive, so a database never goes back, and the tick restarts on v16's own state.
        if (planned.plan.rollup === "v16" && rollup === "v15" && !options.switched)
          return { kind: "switch", rollup: "v16" };
        // One pool at a time: the first that is neither ready nor stuck, or whose retry is due.
        const skipped = new Set(
          stuck.filter((entry) => Date.parse(entry.retryAt) > now()).map((entry) => entry.pool),
        );
        const open = planned.plan.pools.filter((item) => !skipped.has(item.pool));
        const next = open[0];
        if (!next) return { kind: stuck.some((entry) => entry.pool) ? "stuck" : "ready", stuck };
        working = next.pool;
        const result = await run(
          db,
          { ...(planned.plan.rollup ? { rollup: planned.plan.rollup } : {}), pools: [next] },
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
      // A failure before any pool is chosen (the connection, the plan) counts against the tick.
      const pool = working ?? "";
      const same = state.repeat?.reason === "error" && state.repeat.pool === pool;
      const count = same ? state.repeat!.count + 1 : 1;
      const retried = stuckBefore.some((entry) => entry.pool === pool);
      const stuck = retried || count >= bounds.failingAfter;
      if (stuck) console.error("POOL_USAGE_ROLLUP_STUCK", { reason: "error" });
      await save({
        ...state,
        sessions: [...recent, spent],
        lastStop: "error",
        lastHour: undefined,
        repeat: { pool, reason: "error", count },
        ...(stuck ? { stuck: stuckWith(stuckBefore, pool, "error", undefined) } : {}),
        pausedUntil: pause(),
      });
      break;
    }
    if (outcome.kind === "switch") {
      // The hourly ceilings hold across the switch: v15's sessions of the last hour still count.
      await storage.put(autoKeys[outcome.rollup], {
        rollup: outcome.rollup,
        sessions: (state.sessions ?? []).filter((entry) => at - entry.at < hourMs),
      });
      return usageRollupTick(storage, session, { ...options, switched: true });
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
      repeat: state.repeat?.pool === "" ? undefined : state.repeat,
    };
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
    // Only hours recomputed count as progress: a stop before the first hour (a handover, a
    // budget the hour's ceiling cut to nothing) neither clears the pool nor resets its count.
    const progressed = (result.pools[0]?.recomputedHours ?? 0) > 0;
    const cleared = progressed
      ? (ran.stuck ?? []).filter((entry) => entry.pool !== outcome.pool)
      : ran.stuck;
    const repeat = progressed && ran.repeat?.pool === outcome.pool ? undefined : ran.repeat;
    if (result.status === "complete") {
      // The next pool starts on a later tick, so two pools never share one.
      await save({
        ...ran,
        lastStop: "complete",
        lastHour: undefined,
        pools: outcome.pools - 1,
        repeat,
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
        repeat,
        stuck: cleared,
      });
      continue;
    }
    const reason: StuckReason = halted === "lock" ? "lock" : "slow";
    // A slow hour is never done, so it comes back; a hold past the limit may have committed its
    // hour, so it counts for the pool whichever hour it was.
    const hour = halted === "slow_hour" ? result.slowHour : undefined;
    const same =
      state.repeat?.pool === outcome.pool &&
      state.repeat.reason === reason &&
      state.repeat.hour === hour;
    const count = same ? state.repeat!.count + 1 : 1;
    // A stuck pool whose daily retry fails again is stuck again at once.
    const retried = (ran.stuck ?? []).some((entry) => entry.pool === outcome.pool);
    const stuck = retried || count >= (reason === "slow" ? bounds.slowAfter : bounds.failingAfter);
    if (stuck) console.error("POOL_USAGE_ROLLUP_STUCK", { reason, ...(hour ? { hour } : {}) });
    await save({
      ...ran,
      lastStop: halted,
      lastHour: result.slowHour,
      repeat: { pool: outcome.pool, reason, ...(hour ? { hour } : {}), count },
      ...(stuck ? { stuck: stuckWith(ran.stuck ?? [], outcome.pool, reason, hour) } : {}),
      pausedUntil: pause(),
    });
    break;
  }
  return state;
}

/** The active rollup's state, naming its rollup. */
export async function usageRollupAutoState(storage: AutoStorage): Promise<UsageRollupAutoState> {
  const active = await activeState(storage);
  return { ...active.state, rollup: active.rollup };
}

/** The pools whose rollup is stuck, which the minute check reports as a reliability reason. */
export const usageRollupStuckPools = (state: UsageRollupAutoState) =>
  [...new Set((state.stuck ?? []).map((entry) => entry.pool))].sort();

const hex16 = /^[0-9a-f]{16}$/;
// Only a strict UTC timestamp passes: a lenient date parse would let free text through.
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;
const iso = (value: unknown) =>
  typeof value === "string" && isoPattern.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null;
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const stopNames = {
  complete: true,
  budget: true,
  wal: true,
  lock: true,
  slow_hour: true,
  slow_hold: true,
  ceiling: true,
  error: true,
  handover: true,
  not_applied: true,
  stuck: true,
  ready: true,
} satisfies Record<UsageRollupAutoStop, true>;
const stops = new Set<string>(Object.keys(stopNames));
const reasonNames = { slow: true, lock: true, error: true } satisfies Record<StuckReason, true>;
const reasons = new Set<string>(Object.keys(reasonNames));

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
    pools: count(state.pools),
    pendingHours: count(state.pendingHours),
    stuck: (Array.isArray(state.stuck) ? state.stuck : []).flatMap((entry) =>
      typeof entry?.pool === "string" && (entry.pool === "" || hex16.test(entry.pool))
        ? [
            {
              // A tick stuck before it reached any pool names none.
              pool: entry.pool === "" ? null : entry.pool,
              reason: reasons.has(entry.reason) ? entry.reason : null,
              hour: iso(entry.hour),
              retryAt: iso(entry.retryAt),
            },
          ]
        : [],
    ),
  };
}
