import type { HistoryDatabase } from "./schema.ts";
import type {
  CaptureHoursAutoBounds,
  CaptureHoursAutoState,
  CaptureHoursAutoStop,
  CaptureHoursStuck,
} from "./capture-hours-auto.ts";
import { countCaptureBlock, countCaptureHour } from "./capture-hours-count.ts";
import { postgresCode } from "./usage-rollup-apply.ts";
import {
  boundedRead,
  captureBlockHours,
  captureHoursPlanLimitMs,
  captureHoursReadLimitMs,
  pruneCaptureHours,
  countedHours,
  pendingHoursOf,
  planCaptureHours,
  recountBlocks,
  stalestCapture,
  type CaptureBlock,
} from "./capture-hours-plan.ts";

/** What one session changed so far; the tick keeps it even when the session fails. */
export interface CaptureSessionProgress {
  state: CaptureHoursAutoState;
  /** The pool the session was counting, "" before it reached one. */
  working: string;
  /** The block or hour a lost lock stopped. */
  stopHour?: string;
}

export interface CaptureSessionContext {
  readonly db: HistoryDatabase;
  readonly bounds: CaptureHoursAutoBounds;
  readonly now: () => number;
  /** The session's whole budget, and what is left of it. */
  readonly budget: number;
  readonly left: () => number;
  readonly stopped: () => boolean;
  readonly progress: CaptureSessionProgress;
}

const hourMs = 3_600_000;
const within = (hour: string | undefined, block: CaptureBlock) =>
  hour !== undefined &&
  Date.parse(hour) >= Date.parse(block.from) &&
  Date.parse(hour) < Date.parse(block.to);
const blockMs = captureBlockHours * hourMs;
/**
 * SQLSTATE classes that describe the database or the session, never one pool's rows: connection
 * (08), transaction state such as read-only after a failover (25), a schema the code does not match
 * (42), resources (53), object state (55), operator intervention (57) and system errors (58).
 */
const tickClasses = new Set(["08", "25", "42", "53", "55", "57", "58"]);

/**
 * The SQLSTATE of a Postgres error that failed one pool's count, or undefined for any other
 * failure. A real Postgres error has a severity and a five-character SQLSTATE; the bounded session
 * may carry it as the cause of its own error.
 */
export function poolCountFailure(error: unknown): string | undefined {
  const candidates = [
    error,
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const { severity, code } = candidate as { severity?: unknown; code?: unknown };
    if (typeof severity !== "string" || typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code))
      continue;
    return tickClasses.has(code.slice(0, 2)) ? undefined : code;
  }
  return undefined;
}
/** A block's hours, newest first. */
const hoursOf = (block: CaptureBlock) => {
  const hours: string[] = [];
  for (let at = Date.parse(block.to) - hourMs; at >= Date.parse(block.from); at -= hourMs)
    hours.push(new Date(at).toISOString().replace(".000Z", "Z"));
  return hours;
};

/**
 * One session's counting. Pending blocks go round-robin across pools, each pool's newest first, for
 * at most `1 - recountShare` of the budget; then the blocks counted longest ago get the rest, at
 * least that share; then pending blocks again while time is left. A block that runs out its own
 * limit is counted hour by hour from then on, in this session or the next, never whole again.
 */
export async function captureHoursSession(
  context: CaptureSessionContext,
): Promise<CaptureHoursAutoStop> {
  const { db, bounds, now, budget, left, stopped, progress } = context;
  const update = (change: Partial<CaptureHoursAutoState>) => {
    progress.state = { ...progress.state, ...change };
  };
  const state = () => progress.state;
  // Each read runs under 1 s, and never past what the session has left; the plan, whose cost grows
  // with the pools, under its own 3 s.
  const read = <T>(work: () => Promise<T>) => boundedRead(db, left, work);
  const planStarted = performance.now();
  const plan = await boundedRead(
    db,
    left,
    () => planCaptureHours(db, bounds.lookbackHours),
    captureHoursPlanLimitMs,
  );
  update({ planMs: Math.round((performance.now() - planStarted) * 10) / 10 });
  if (!plan) return "not_applied";
  const { pools, plannedAt } = plan;
  // The tick reached its database and plan, so it is no longer failing as a whole.
  const done = await read(() =>
    countedHours(db, [...(state().stuck ?? []), ...(state().slow ?? [])]),
  );
  const open = (entry: { pool: string; hour?: string }) =>
    !entry.hour || !done.has(`${entry.pool}|${entry.hour}`);
  const known = new Set(pools.map((pool) => pool.pool));
  update({
    stuck: (state().stuck ?? []).filter((entry) => entry.pool !== "" && open(entry)),
    slow: (state().slow ?? []).filter(open),
    repeat: state().repeat?.pool === "" ? undefined : state().repeat,
    // A split block stays split while its pool is counted and the block is inside the lookback, so
    // a recount of it goes hour by hour too: each pool keeps its own, at most its lookback's blocks.
    split: (state().split ?? []).flatMap((entry) => {
      const oldest = Date.parse(plannedAt) - (bounds.lookbackHours + 3 + blockMs / hourMs) * hourMs;
      const blocks = (Array.isArray(entry?.blocks) ? entry.blocks : []).filter(
        (start) => typeof start === "string" && Date.parse(start) > oldest,
      );
      return known.has(entry.pool) && blocks.length ? [{ pool: entry.pool, blocks }] : [];
    }),
    // A pool whose rest after an error is over is retried; its count stands until it counts.
    failing: (state().failing ?? []).filter((entry) => known.has(entry.pool)),
    stalestCheckedAt:
      (await read(() => stalestCapture(db)).catch(() => undefined)) ?? state().stalestCheckedAt,
  });
  // Counts older than the lookback are never complete to the summary: a bounded prune each
  // session keeps them, and the recount's work, from growing. Its failure stops no count.
  await boundedRead(
    db,
    left,
    () => pruneCaptureHours(db, bounds.lookbackHours),
    captureHoursReadLimitMs,
    true,
  ).catch(() => console.error("POOL_CAPTURE_HOURS_PRUNE_FAILED"));
  const pending = new Map(
    pools.map((pool) => [pool.pool, { blocks: pool.pendingBlocks, hours: pool.pendingHours }]),
  );
  const tally = () => {
    const all = [...pending.values()];
    update({
      pools: all.filter((n) => n.blocks > 0).length,
      pendingBlocks: all.reduce((sum, n) => sum + n.blocks, 0),
      pendingHours: all.reduce((sum, n) => sum + n.hours, 0),
    });
  };
  tally();
  // A pool in its slow wait, or resting after an error, is left alone.
  const waiting = () =>
    new Set(
      [...(state().slow ?? []), ...(state().failing ?? [])]
        .filter((entry) => Date.parse(entry.until) > now())
        .map((entry) => entry.pool),
    );
  const stuckWith = (entry: CaptureHoursStuck) => [
    ...(state().stuck ?? []).filter((item) => item.pool !== entry.pool),
    entry,
  ];
  let slowed = false;
  // A pool that slowed is left alone for the rest of the session.
  const resting = new Set<string>();

  /** A single hour past its own limit: the pool waits, and three in a row is stuck. */
  const slowHour = (pool: string, hour: string, readMs: number) => {
    const before = (state().slow ?? []).find((entry) => entry.pool === pool);
    const repeats = before?.hour === hour ? before.count + 1 : 1;
    const until = new Date(now() + bounds.slowPauseMs).toISOString();
    // Loud once, when the pool first becomes stuck; its retries after each wait stay quiet.
    if (repeats === bounds.slowAfter)
      console.error("POOL_CAPTURE_HOURS_STUCK", { reason: "slow", hour });
    update({
      lastHour: hour,
      lastHourReadMs: readMs,
      lastHourPool: pool,
      slow: [
        ...(state().slow ?? []).filter((entry) => entry.pool !== pool),
        { pool, hour, count: repeats, until },
      ],
      ...(repeats >= bounds.slowAfter
        ? { stuck: stuckWith({ pool, reason: "slow", hour, retryAt: until }) }
        : {}),
    });
    slowed = true;
    resting.add(pool);
  };
  /**
   * A count of this pool failed in Postgres: only the pool rests, an hour, while the others go on;
   * six in a row is stuck, loud once, and it is retried after each rest.
   */
  const failedPool = (pool: string) => {
    const before = (state().failing ?? []).find((entry) => entry.pool === pool);
    const count = (before?.count ?? 0) + 1;
    const until = new Date(now() + bounds.pauseMs).toISOString();
    if (count === bounds.failingAfter)
      console.error("POOL_CAPTURE_HOURS_STUCK", { reason: "error" });
    update({
      failing: [
        ...(state().failing ?? []).filter((entry) => entry.pool !== pool),
        { pool, count, until },
      ],
      ...(count >= bounds.failingAfter
        ? { stuck: stuckWith({ pool, reason: "error", retryAt: until }) }
        : {}),
    });
    resting.add(pool);
  };
  /** Counted: the pool is no longer failing, and its slow or stuck hour in the block is done. */
  const counted = (block: CaptureBlock) => {
    const cleared = (entry: { pool: string; hour?: string }) =>
      entry.pool !== block.pool || (entry.hour !== undefined && !within(entry.hour, block));
    update({
      // The hour that last stopped a session is named until it is counted.
      ...(state().lastHourPool === block.pool && within(state().lastHour, block)
        ? { lastHour: undefined, lastHourReadMs: undefined, lastHourPool: undefined }
        : {}),
      stuck: (state().stuck ?? []).filter(cleared),
      slow: (state().slow ?? []).filter(cleared),
      failing: (state().failing ?? []).filter((entry) => entry.pool !== block.pool),
      repeat: state().repeat?.pool === block.pool ? undefined : state().repeat,
    });
  };
  const startOf = (block: CaptureBlock) =>
    new Date(Math.floor(Date.parse(block.from) / blockMs) * blockMs)
      .toISOString()
      .replace(".000Z", "Z");
  const isSplit = (block: CaptureBlock) =>
    (state().split ?? []).some(
      (entry) => entry.pool === block.pool && entry.blocks.includes(startOf(block)),
    );
  const markSplit = (block: CaptureBlock) => {
    const others = (state().split ?? []).filter((entry) => entry.pool !== block.pool);
    const mine = (state().split ?? []).find((entry) => entry.pool === block.pool)?.blocks ?? [];
    update({ split: [...others, { pool: block.pool, blocks: [...mine, startOf(block)] }] });
  };

  /**
   * One block, whole or hour by hour. Returns the session's stop, "rest" to leave the pool for the
   * session, "mark" once the session has spent `until` between two of its hours, or undefined once
   * the block is counted. A count that fails in Postgres rests only its pool.
   */
  const countBlock = async (
    block: CaptureBlock,
    recount = false,
    until = budget,
  ): Promise<CaptureHoursAutoStop | "rest" | "mark" | undefined> => {
    try {
      return await countBlockOnce(block, recount, until);
    } catch (error) {
      // Only Postgres failing the pool's own statement is the pool's: anything else, a socket's code
      // or a database-wide state, is the tick's, and pauses it whole with no pool named.
      const code = poolCountFailure(error);
      if (code === undefined) {
        progress.working = "";
        throw error;
      }
      console.error("POOL_CAPTURE_HOURS_COUNT_FAILED", { code });
      failedPool(block.pool);
      return "rest";
    }
  };
  const countBlockOnce = async (
    block: CaptureBlock,
    recount: boolean,
    until: number,
  ): Promise<CaptureHoursAutoStop | "rest" | "mark" | undefined> => {
    if (stopped()) return "handover";
    if (left() <= 0) return "budget";
    progress.working = block.pool;
    if (!isSplit(block)) {
      const result = await countCaptureBlock(
        db,
        block.pool,
        block.from,
        block.to,
        left,
        bounds.countLimitMs,
      );
      if (result.kind === "done") {
        counted(block);
        return undefined;
      }
      if (result.kind === "budget") return "budget";
      if (result.kind === "lock") {
        progress.stopHour = block.from;
        return "lock";
      }
      if (result.kind === "slow") {
        slowHour(block.pool, block.from, result.readMs);
        return "rest";
      }
      // Past its own limit: from now on hour by hour, starting in this session if time is left.
      markSplit(block);
    }
    // A recount takes every hour of it; a pending one only the hours without a settled count. A
    // statement timeout in that read is this pool's own: it waits like a slow hour, unless the
    // session's budget cut the read short, which is a budget stop.
    let hours: string[];
    if (recount) hours = hoursOf(block);
    else {
      const limit = Math.floor(left());
      try {
        hours = await read(() => pendingHoursOf(db, block));
      } catch (error) {
        if (postgresCode(error) !== "57014") throw error;
        if (limit < captureHoursReadLimitMs) return "budget";
        slowHour(block.pool, block.from, captureHoursReadLimitMs);
        return "rest";
      }
    }
    for (const hour of hours) {
      if (stopped()) return "handover";
      if (left() <= 0) return "budget";
      // A split block never takes the session past its share: the rest of it waits its turn.
      if (budget - left() >= until) return "mark";
      const result = await countCaptureHour(db, block.pool, hour, left, bounds.countLimitMs);
      if (result.kind === "budget") return "budget";
      if (result.kind === "lock") {
        progress.stopHour = hour;
        return "lock";
      }
      if (result.kind === "slow" || result.kind === "split") {
        slowHour(block.pool, hour, result.readMs);
        return "rest";
      }
      counted({
        pool: block.pool,
        from: hour,
        to: new Date(Date.parse(hour) + hourMs).toISOString(),
      });
    }
    counted(block);
    return undefined;
  };

  // Each pool's pending blocks, newest first; the pools in turn, starting after the last one served.
  const queues = new Map(pools.map((pool) => [pool.pool, [...pool.blocks]]));
  const order = pools.map((pool) => pool.pool);
  const after = order.indexOf(state().nextPool ?? "");
  const rotation = [...order.slice(after + 1), ...order.slice(0, after + 1)];
  let turn = 0;
  const nextPending = () => {
    const held = waiting();
    for (let tries = 0; tries < rotation.length; tries++) {
      const pool = rotation[turn++ % rotation.length]!;
      if (held.has(pool) || resting.has(pool)) continue;
      const block = queues.get(pool)?.shift();
      if (block) return block;
    }
    return undefined;
  };
  /** Pending blocks until the session has spent `until` of its budget. */
  const fill = async (until: number) => {
    while (budget - left() < until) {
      const block = nextPending();
      if (!block) return undefined;
      const stop = await countBlock(block, false, until);
      update({ nextPool: block.pool });
      if (stop === "rest") continue;
      if (stop === "mark") return undefined;
      if (stop) return stop;
      const was = pending.get(block.pool)!;
      pending.set(block.pool, {
        blocks: Math.max(0, was.blocks - 1),
        hours: Math.max(0, was.hours - (block.missing ?? 0)),
      });
      tally();
    }
    return undefined;
  };
  const first = await fill(budget * (1 - bounds.recountShare));
  if (first) return first;
  // The guaranteed share: the blocks counted longest ago, for as long as the session lasts.
  const counting = order.filter((pool) => !waiting().has(pool) && !resting.has(pool));
  const stale = await read(() =>
    recountBlocks(db, counting, bounds.recount, plannedAt, bounds.lookbackHours),
  );
  for (const block of stale) {
    if (waiting().has(block.pool) || resting.has(block.pool)) continue;
    const stop = await countBlock(block, true);
    if (stop === "budget" || stop === "mark") break;
    if (stop === "rest") continue;
    if (stop) return stop;
    update({ recountPosition: { pool: block.pool, block: block.from } });
  }
  // What is left of the session goes back to pending blocks.
  const rest = await fill(budget);
  if (rest) return rest;
  const held = waiting();
  const unserved = pools.some(
    (pool) => pending.get(pool.pool)!.blocks > 0 && !held.has(pool.pool) && !resting.has(pool.pool),
  );
  if (unserved) return "budget";
  if (pools.some((pool) => pending.get(pool.pool)!.blocks > 0)) return slowed ? "slow" : "waiting";
  return "complete";
}
