import type { HistoryDatabase } from "./schema.ts";
import { captureHoursCountLimitMs } from "./capture-hours-count.ts";
import { captureHoursLookbackHours, listedBlocks } from "./capture-hours-plan.ts";
import { captureHoursSession, type CaptureSessionProgress } from "./capture-hours-session.ts";

export { captureHoursInspect } from "./capture-hours-inspect.ts";

/**
 * The pool counts each of its settled hours' Home usage rows itself: each model-history pass ends,
 * after the usage rollup's tick, with one tick of at most two bounded sessions of its own. Each
 * counts six-hour blocks of the last 400 days, one short transaction a block, the pools in turn
 * by their newest pending block, and gives at least a quarter of its time to recounting the blocks
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
  /** The most blocks one recount read lists, the ones counted longest ago. */
  readonly recount: number;
  /** The least share of each session's budget the recount gets; pending blocks get the rest. */
  readonly recountShare: number;
  /** The hours before the settle horizon each pool's counts cover. */
  readonly lookbackHours: number;
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
  recount: listedBlocks,
  recountShare: 0.25,
  lookbackHours: captureHoursLookbackHours,
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
  /** The pool `lastHour` belongs to: another pool counting the same hour never clears it. */
  readonly lastHourPool?: string;
  /** Pools with pending blocks, and the pending blocks and hours across them. */
  readonly pools?: number;
  readonly pendingBlocks?: number;
  readonly pendingHours?: number;
  /** The block the recount reached last. */
  readonly recountPosition?: { readonly pool: string; readonly block: string };
  /** The pool whose block was counted last: the next session starts with the one after it. */
  readonly nextPool?: string;
  /** Each pool's blocks that ran out their own limit, by start, counted hour by hour from then on. */
  readonly split?: readonly { readonly pool: string; readonly blocks: readonly string[] }[];
  /** Pools whose counts failed in Postgres: each rests until `until`, and `count` in a row. */
  readonly failing?: readonly {
    readonly pool: string;
    readonly count: number;
    readonly until: string;
  }[];
  /** How long the last plan read took, which grows with the pools against its 3 s limit. */
  readonly planMs?: number;
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
/** The least a session needs for its plan read when no plan's duration is recorded yet. */
const planFloorMs = 50;

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
      ...(hour ? { lastHour: hour, lastHourReadMs: undefined, lastHourPool: pool } : {}),
      repeat: { pool, reason, count },
      ...(stuck
        ? { stuck: stuckWith(base.stuck ?? [], { pool, reason, retryAt: pausedUntil }) }
        : {}),
      pausedUntil,
    });
  };
  for (let index = 0; index < bounds.sessions; index++) {
    if (stopped()) {
      await save({ ...state, lastStop: "handover" });
      break;
    }
    const at = now();
    const recent = (state.sessions ?? []).filter((entry) => at - entry.at < hourMs);
    const msLeft = bounds.hourMs - recent.reduce((sum, entry) => sum + entry.ms, 0);
    // A session the ceiling would cut short of its own plan read never starts: the plan would time
    // out and fail the tick.
    if (msLeft <= 0 || msLeft < (state.planMs ?? planFloorMs)) {
      await save({ ...state, sessions: recent, lastStop: "ceiling" });
      break;
    }
    const budget = Math.min(bounds.sessionMs, msLeft);
    const left = () => budget - (now() - at);
    // Every change the session makes is kept here, so a failure mid-session keeps its progress.
    const progress: CaptureSessionProgress = { state: { ...state }, working: "" };
    let stop: CaptureHoursAutoStop | undefined;
    try {
      stop = await session((db) =>
        captureHoursSession({ db, bounds, now, budget, left, stopped, progress }),
      );
    } catch (error) {
      console.error("POOL_CAPTURE_HOURS_TICK_FAILED", {
        failure: error instanceof Error ? error.name : "unknown",
      });
      // Whatever reached here is the tick's own: a pool's count failure rests only its pool.
      await failed("error", "", {
        ...progress.state,
        sessions: [...recent, { at, ms: now() - at }],
      });
      break;
    }
    const next = progress.state;
    const working = progress.working;
    const stopHour = progress.stopHour;
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
