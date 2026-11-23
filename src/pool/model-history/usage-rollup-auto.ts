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
  readonly hourMs: number;
  readonly hourWalBytes: number;
  readonly pauseMs: number;
  readonly stuckAfter: number;
  readonly hourLimitMs: number;
}
export const usageRollupAutoBounds: UsageRollupAutoBounds = {
  sessions: 2,
  sessionMs: 12_000,
  sessionWalBytes: 16 * 1024 * 1024,
  /** Backfill time and write-ahead log in any one hour of wall time, across ticks. */
  hourMs: 300_000,
  hourWalBytes: 256 * 1024 * 1024,
  /** After any stop other than its own time or WAL budget, the next tick waits this long. */
  pauseMs: 3_600_000,
  /** The same hour stopping slow this many times in a row is stuck until a person looks. */
  stuckAfter: 3,
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
  | "not_applied"
  | "ready";

export interface UsageRollupAutoState {
  readonly lastTickAt?: string;
  readonly lastStop?: UsageRollupAutoStop;
  readonly lastHour?: string;
  /** Pools not ready yet, and the hours left in the pool the last session worked on. */
  readonly pools?: number;
  readonly pendingHours?: number;
  readonly pausedUntil?: string;
  readonly stuck?: { readonly pool: string; readonly hour: string };
  readonly repeat?: { readonly pool: string; readonly hour: string; readonly count: number };
  readonly window?: { readonly start: number; readonly ms: number; readonly walBytes: number };
}

interface AutoStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

type Session = <T>(work: (db: HistoryDatabase) => Promise<T>) => Promise<T>;

type Outcome =
  | { kind: "not_applied" | "ready" }
  | {
      kind: "ran";
      pool: string;
      pools: number;
      result: Awaited<ReturnType<typeof runUsageRollup>>;
    };

const notApplied = "The usage rollup migration is not applied";

/** One tick. Returns the state it stored; never throws for a backfill failure, only logs it. */
export async function usageRollupTick(
  storage: AutoStorage,
  session: Session,
  options: { now?: () => number; bounds?: Partial<UsageRollupAutoBounds> } = {},
): Promise<UsageRollupAutoState> {
  const now = options.now ?? (() => Date.now());
  const bounds = { ...usageRollupAutoBounds, ...options.bounds };
  const previous = (await storage.get<UsageRollupAutoState>(usageRollupAutoKey)) ?? {};
  const started = now();
  if (previous.stuck) return previous;
  if (previous.pausedUntil && Date.parse(previous.pausedUntil) > started) return previous;
  let window =
    previous.window && started - previous.window.start < 3_600_000
      ? { ...previous.window }
      : { start: started, ms: 0, walBytes: 0 };
  let state: UsageRollupAutoState = { ...previous, pausedUntil: undefined };
  const pause = () => new Date(now() + bounds.pauseMs).toISOString();
  for (let index = 0; index < bounds.sessions; index++) {
    const msLeft = bounds.hourMs - window.ms;
    const walLeft = bounds.hourWalBytes - window.walBytes;
    if (msLeft <= 0 || walLeft <= 0) {
      state = { ...state, lastStop: "ceiling" };
      break;
    }
    const sessionStarted = now();
    let outcome: Outcome;
    try {
      outcome = await session(async (db): Promise<Outcome> => {
        let planned: Awaited<ReturnType<typeof planUsageRollup>>;
        try {
          planned = await planUsageRollup(db);
        } catch (error) {
          if (error instanceof Error && error.message === notApplied)
            return { kind: "not_applied" };
          throw error;
        }
        // One pool at a time: the first that is not ready, and only it, in this session.
        const next = planned.plan.pools[0];
        if (!next) return { kind: "ready" };
        const result = await runUsageRollup(
          db,
          { pools: [next] },
          Math.min(bounds.sessionMs, msLeft),
          now,
          Math.min(bounds.sessionWalBytes, walLeft, usageRollupWalPerCall),
          bounds.hourLimitMs,
        );
        return { kind: "ran", pool: next.pool, pools: planned.plan.pools.length, result };
      });
    } catch (error) {
      window = { ...window, ms: window.ms + (now() - sessionStarted) };
      console.error("POOL_USAGE_ROLLUP_TICK_FAILED", {
        failure: error instanceof Error ? error.name : "unknown",
      });
      state = { ...state, lastStop: "error", pausedUntil: pause() };
      break;
    }
    window = { ...window, ms: window.ms + (now() - sessionStarted) };
    if (outcome.kind !== "ran") {
      state = { ...state, lastStop: outcome.kind, pools: 0, pendingHours: 0 };
      break;
    }
    const { result } = outcome;
    window = { ...window, walBytes: window.walBytes + Math.max(0, result.walBytes) };
    const pendingHours = result.pools[0]?.remainingHours ?? 0;
    state = { ...state, pools: outcome.pools, pendingHours };
    if (result.status === "complete") {
      // The next pool starts on a later tick, so two pools never share one.
      state = { ...state, lastStop: "complete", pools: outcome.pools - 1, repeat: undefined };
      break;
    }
    const stopped = result.stopped ?? "budget";
    state = { ...state, lastStop: stopped, lastHour: result.slowHour };
    if (stopped === "budget" || stopped === "wal") {
      state = { ...state, repeat: undefined };
      continue;
    }
    if (stopped === "slow_hour" && result.slowHour) {
      const same =
        previous.repeat?.pool === outcome.pool && previous.repeat.hour === result.slowHour;
      const count = same ? previous.repeat!.count + 1 : 1;
      state = { ...state, repeat: { pool: outcome.pool, hour: result.slowHour, count } };
      if (count >= bounds.stuckAfter) {
        state = { ...state, stuck: { pool: outcome.pool, hour: result.slowHour } };
        console.error("POOL_USAGE_ROLLUP_STUCK", { hour: result.slowHour });
        break;
      }
    }
    state = { ...state, pausedUntil: pause() };
    break;
  }
  state = { ...state, lastTickAt: new Date(started).toISOString(), window };
  await storage.put(usageRollupAutoKey, state);
  return state;
}

export async function usageRollupAutoState(storage: AutoStorage) {
  return (await storage.get<UsageRollupAutoState>(usageRollupAutoKey)) ?? {};
}
