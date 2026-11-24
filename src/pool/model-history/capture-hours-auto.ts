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
  /** An hour whose count ran out its limit waits this long; its pool and the others go on. */
  readonly slowPauseMs: number;
  /**
   * The same pool-hour slow this many times in a row is stuck. It is then left out of the pool's
   * counting and retried alone, at the start of a session, once per wait, each try under the next
   * of `stuckRetryLimitsMs`. Past the last it is given up: it stays stuck and is not tried again.
   */
  readonly slowAfter: number;
  /** A stuck hour's retries, each a longer limit, none longer than a session's budget. */
  readonly stuckRetryLimitsMs: readonly number[];
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
  // One try at 3 s, then tries at up to 10 s, the most a 12 s session can give one hour, until one
  // runs the full 10 s. Each comes after a 10 min wait; a try the session cuts short of 10 s is not
  // the last, so a stuck hour costs a few retries of the hourly 120 s, never one each wait.
  stuckRetryLimitsMs: [3_000, 10_000],
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
  /**
   * A count ran out its own limit this session, and nothing was left it could count: hours in their
   * wait, or the blocks of a pool whose second slow count this session ended its turn.
   */
  | "slow"
  | "ceiling"
  | "error"
  | "handover"
  | "not_applied"
  /** All that is left pending is hours in their slow wait. */
  | "waiting";

type StuckReason = "slow" | "lock" | "error";
export interface CaptureHoursStuck {
  /** A pool's own 16-hex history id, or "" for a tick that fails before it reaches any pool. */
  readonly pool: string;
  readonly reason: StuckReason;
  readonly hour?: string;
  readonly retryAt: string;
  /** A slow hour that ran out its last retry limit: it is not tried again. */
  readonly gaveUp?: true;
}
export interface CaptureHoursSlowWait {
  readonly pool: string;
  readonly hour: string;
  /** Slow counts of this hour in a row. */
  readonly count: number;
  readonly until: string;
  /** "read": the block's read of its pending hours ran out, keyed on the block's start. */
  readonly limit?: "read";
  /** A stuck hour's tries under a retry limit so far: the next one runs under the next limit. */
  readonly retries?: number;
  /** A stuck hour that ran out its last retry limit: held from counting and not tried again. */
  readonly gaveUp?: true;
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
  /** Each pool's last slow stop: which limit ran out, on which hour of which block, and how long. */
  readonly lastSlow?: readonly {
    readonly pool: string;
    readonly at: string;
    readonly hour: string;
    readonly block: string;
    readonly limit: "count" | "read";
    readonly elapsedMs: number;
    readonly repeat: number;
  }[];
  /** Each counted pool's own pending blocks and hours, as the last session left them. */
  readonly byPool?: readonly {
    readonly pool: string;
    readonly pendingBlocks: number;
    readonly pendingHours: number;
  }[];
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

/**
 * The pools whose counting is stuck, which the minute check reports as a reliability reason: any
 * with a stuck entry, and any with a count's wait on an hour slow `slowAfter` times in a row, given
 * up or not, since a pool keeps one stuck entry and another hour can replace it.
 */
export const captureHoursStuckPools = (
  state: CaptureHoursAutoState,
  slowAfter = captureHoursAutoBounds.slowAfter,
) =>
  [
    ...new Set([
      ...(state.stuck ?? []).map((entry) => entry.pool),
      ...(state.slow ?? [])
        .filter((entry) => entry.limit !== "read" && entry.count >= slowAfter)
        .map((entry) => entry.pool),
    ]),
  ].sort();
