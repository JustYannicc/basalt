import type { HistoryDatabase } from "./schema.ts";
import type {
  CaptureHoursAutoBounds,
  CaptureHoursRecount,
  CaptureHoursAutoState,
  CaptureHoursAutoStop,
  CaptureHoursStuck,
} from "./capture-hours-auto.ts";
import { countCaptureBlock, countCaptureHour } from "./capture-hours-count.ts";
import { remapCaptureHours } from "./capture-hours-mark.ts";
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
  /** Whether this session reads Home's mapping: the tick's first does. */
  readonly remap: boolean;
}

const hourMs = 3_600_000;
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
/** A stored recount whose boundaries are times; anything else is dropped. */
const validRecount = (entry: unknown): entry is CaptureHoursRecount =>
  typeof entry === "object" &&
  entry !== null &&
  instant((entry as CaptureHoursRecount).before) &&
  ((entry as CaptureHoursRecount).next === undefined ||
    instant((entry as CaptureHoursRecount).next));
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
 * One session's counting. Pending blocks go round-robin across pools, each pool's newest first,
 * while time is left; then what is left counts the pools Home remapped again, newest first. Nothing
 * is counted again otherwise (capture-hours-mark.ts), and nothing on a timer. A block that runs out
 * its own limit is counted hour by hour from then on, in this session or the next.
 */
export async function captureHoursSession(
  context: CaptureSessionContext,
): Promise<CaptureHoursAutoStop> {
  const { db, bounds, now, left, stopped, progress } = context;
  const update = (change: Partial<CaptureHoursAutoState>) => {
    progress.state = { ...progress.state, ...change };
  };
  const state = () => progress.state;
  // Each read runs under 1 s, and never past what the session has left; the plan and the remap
  // read, whose cost grows with the pools, under their own 3 s.
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
  // The pools Home remapped since the last tick are counted again, as far back as their counts go.
  // Read once a tick, by its first session. A failed read fails the tick like the plan's: counting
  // on unseen remaps would hide them.
  if (context.remap) {
    const remap = await boundedRead(
      db,
      left,
      () => remapCaptureHours(db, state().mapping),
      captureHoursPlanLimitMs,
    );
    // A cycle in progress keeps its boundary, so a pool Home changes on every pass still finishes
    // it; a newer change only queues one more cycle, from the newest change, once this one is done.
    const recounting: Record<string, CaptureHoursRecount> = {};
    for (const [pool, entry] of Object.entries(state().recount ?? {}))
      if (remap.mapping.pools[pool] !== undefined && validRecount(entry)) recounting[pool] = entry;
    for (const pool of remap.remapped) {
      const was = recounting[pool];
      recounting[pool] = was ? { before: was.before, next: remap.at } : { before: remap.at };
    }
    update({
      mapping: remap.mapping,
      recount: recounting,
      ...(remap.remapped.length
        ? { lastRemap: { at: new Date(now()).toISOString(), pools: remap.remapped.length } }
        : {}),
    });
  }
  // A pool that became ready since the tick's read is counted from the next tick on: its counts
  // must not predate the mapping its changes are compared against.
  const mapped = state().mapping?.pools;
  const pools = context.remap
    ? plan.pools
    : plan.pools.filter((pool) => mapped?.[pool.pool] !== undefined);
  const { plannedAt } = plan;
  // The tick reached its database and plan, so it is no longer failing as a whole.
  const done = await read(() =>
    countedHours(db, [...(state().stuck ?? []), ...(state().slow ?? [])]),
  );
  const open = (entry: { pool: string; hour?: string }) =>
    !entry.hour || !done.has(`${entry.pool}|${entry.hour}`);
  const known = new Set(pools.map((pool) => pool.pool));
  // A slow read of a block's pending hours is the block's, keyed on the block's start: it, and the
  // stuck entry it leads to, stand until the whole block is counted, however that hour fares, or
  // until the block falls out of the lookback. Pools no longer counted drop out.
  const oldestBlock =
    Date.parse(plannedAt) - (bounds.lookbackHours + 3 + blockMs / hourMs) * hourMs;
  const reads = new Set(
    (state().slow ?? [])
      .filter((entry) => entry.limit === "read" && Date.parse(entry.hour) > oldestBlock)
      .map((entry) => `${entry.pool}|${entry.hour}`),
  );
  const isRead = (entry: { pool: string; hour?: string }) =>
    entry.hour !== undefined && reads.has(`${entry.pool}|${entry.hour}`);
  update({
    // A stuck hour that left the lookback is never counted again: it drops with it.
    stuck: (state().stuck ?? []).filter(
      (entry) =>
        entry.pool !== "" &&
        (entry.hour === undefined || Date.parse(entry.hour) > oldestBlock) &&
        (isRead(entry) || open(entry)),
    ),
    // A count's wait on an hour that left the lookback is never retried: it drops too.
    slow: (state().slow ?? []).filter(
      (entry) =>
        known.has(entry.pool) &&
        (entry.limit === "read"
          ? isRead(entry)
          : Date.parse(entry.hour) > oldestBlock && open(entry)),
    ),
    lastSlow: (state().lastSlow ?? []).filter((entry) => known.has(entry.pool)),
    repeat: state().repeat?.pool === "" ? undefined : state().repeat,
    // A split block stays split while its pool is counted and the block is inside the lookback, so
    // a later count of it goes hour by hour too: each pool keeps its own, at most its lookback's.
    split: (state().split ?? []).flatMap((entry) => {
      const blocks = (Array.isArray(entry?.blocks) ? entry.blocks : []).filter(
        (start) => typeof start === "string" && Date.parse(start) > oldestBlock,
      );
      return known.has(entry.pool) && blocks.length ? [{ pool: entry.pool, blocks }] : [];
    }),
    // A pool whose rest after an error is over is retried; its count stands until it counts.
    failing: (state().failing ?? []).filter((entry) => known.has(entry.pool)),
    stalestCheckedAt:
      (await read(() => stalestCapture(db)).catch(() => undefined)) ?? state().stalestCheckedAt,
  });
  // Counts older than the lookback are never complete to the summary: a bounded prune each
  // session keeps them from growing. Its failure stops no count.
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
      // Each pool's own, so one pool held back shows while the total falls.
      byPool: [...pending.entries()].map(([pool, n]) => ({
        pool,
        pendingBlocks: n.blocks,
        pendingHours: n.hours,
      })),
    });
  };
  tally();
  // A pool resting after an error is left alone. A slow hour holds only itself: see slowWaiting.
  const waiting = () =>
    new Set(
      (state().failing ?? [])
        .filter((entry) => Date.parse(entry.until) > now())
        .map((entry) => entry.pool),
    );
  const stuckWith = (entry: CaptureHoursStuck) => [
    ...(state().stuck ?? []).filter((item) => item.pool !== entry.pool),
    entry,
  ];
  let slowed = false;
  // A pool whose count failed in Postgres, or that ran out two limits, is left for the session.
  const resting = new Set<string>();
  // Each pool's slow counts this session: past two its turn ends, so a pool of many slow hours costs
  // a session about two limits, never most of it, and the other pools keep their share.
  const slowCounts = new Map<string, number>();
  const slowsPerSession = 2;
  /** Whether the block's read of its pending hours is in its own slow wait. */
  const readWaiting = (block: CaptureBlock) =>
    (state().slow ?? []).some(
      (entry) =>
        entry.limit === "read" &&
        entry.pool === block.pool &&
        entry.hour === startOf(block) &&
        Date.parse(entry.until) > now(),
    );
  // The plan's pools in a fixed order, so a log line and inspect name a pool by its place alone.
  const ordinals = [...known].sort();
  const ordinal = (pool: string) => ordinals.indexOf(pool) + 1;
  /** The time a stuck hour's retry leaves between its limit and the session's end. */
  const stuckRetryMarginMs = 250;
  /** Whether a count's wait is a stuck hour's: it is only ever retried alone, by retryStuck. */
  const isStuck = (entry: { count: number; limit?: "read" }) =>
    entry.limit !== "read" && entry.count >= bounds.slowAfter;
  /**
   * The hours in their slow wait, and every stuck hour, as pool|hour: each is left out of its pool's
   * counting, which goes on.
   */
  const slowWaiting = () =>
    new Set(
      (state().slow ?? [])
        .filter(
          (entry) => entry.limit !== "read" && (Date.parse(entry.until) > now() || isStuck(entry)),
        )
        .map((entry) => `${entry.pool}|${entry.hour}`),
    );

  /**
   * A single hour past its own limit: that hour waits, and three in a row of it is stuck; its pool
   * goes on with its other hours. Logged each time, closed, and kept as the pool's last slow stop:
   * the pool's place, the hour, its six-hour block, the limit it ran out (the hour's count, or its
   * block's read of pending hours), the time the attempt took as measured, and how many in a row.
   */
  const slowHour = (
    block: CaptureBlock,
    hour: string,
    readMs: number,
    limit: "count" | "read",
    elapsedMs: number,
  ) => {
    const pool = block.pool;
    // A slow count and a slow read of the same hour are two waits, each with its own repeats.
    const same = (entry: { pool: string; hour: string; limit?: "read" }) =>
      entry.pool === pool && entry.hour === hour && (entry.limit ?? "count") === limit;
    const before = (state().slow ?? []).find(same);
    const repeats = (before?.count ?? 0) + 1;
    const until = new Date(now() + bounds.slowPauseMs).toISOString();
    const stop = {
      hour,
      block: startOf(block),
      limit,
      elapsedMs: Math.round(elapsedMs),
      repeat: repeats,
    };
    console.error("POOL_CAPTURE_HOURS_SLOW", { pool: ordinal(pool), ...stop });
    // Loud once, when the hour first becomes stuck; its retries after each wait stay quiet.
    if (repeats === bounds.slowAfter)
      console.error("POOL_CAPTURE_HOURS_STUCK", { reason: "slow", hour });
    update({
      lastHour: hour,
      lastHourReadMs: readMs,
      lastHourPool: pool,
      slow: [
        ...(state().slow ?? []).filter((entry) => !same(entry)),
        { pool, hour, count: repeats, until, ...(limit === "read" ? { limit } : {}) },
      ],
      lastSlow: [
        ...(state().lastSlow ?? []).filter((entry) => entry.pool !== pool),
        { pool, at: new Date(now()).toISOString(), ...stop },
      ],
      ...(repeats >= bounds.slowAfter
        ? { stuck: stuckWith({ pool, reason: "slow", hour, retryAt: until }) }
        : {}),
    });
    slowed = true;
    const slows = (slowCounts.get(pool) ?? 0) + 1;
    slowCounts.set(pool, slows);
    if (slows >= slowsPerSession) resting.add(pool);
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
  /**
   * Whether an entry is the read's wait of this block, or the stuck entry it led to: keyed on the
   * block's start, cleared only by the whole block counted or by its read answering, never by one
   * of its hours counted alone, as a cut session counts them.
   */
  const readWait = (block: CaptureBlock, entry: { pool: string; hour?: string; limit?: string }) =>
    entry.limit === "read" && entry.pool === block.pool && entry.hour === startOf(block);
  /** The stuck entry a read's wait led to: on the block's start while that read's wait stands. */
  const readStuck = (block: CaptureBlock, entry: { pool: string; hour?: string }) =>
    entry.pool === block.pool &&
    entry.hour === startOf(block) &&
    (state().slow ?? []).some((wait) => readWait(block, wait));
  /**
   * The block's read answered: its read's wait, and any stuck entry from it, are over. A count's wait
   * on the same hour is that hour's own and stands.
   */
  const readAnswered = (block: CaptureBlock) =>
    update({
      stuck: (state().stuck ?? []).filter((entry) => !readStuck(block, entry)),
      slow: (state().slow ?? []).filter((entry) => !readWait(block, entry)),
    });
  /** Counted: the whole block, or with `hour` one hour of it. */
  const counted = (block: CaptureBlock, hour = false) => {
    const kept =
      (read: (entry: { pool: string; hour?: string; limit?: string }) => boolean) =>
      (entry: { pool: string; hour?: string; limit?: string }) => {
        if (entry.pool !== block.pool) return true;
        if (read(entry)) return hour;
        return entry.hour !== undefined && !within(entry.hour, block);
      };
    update({
      // The hour that last stopped a session is named until it is counted.
      ...(state().lastHourPool === block.pool && within(state().lastHour, block)
        ? { lastHour: undefined, lastHourReadMs: undefined, lastHourPool: undefined }
        : {}),
      stuck: (state().stuck ?? []).filter(kept((entry) => readStuck(block, entry))),
      slow: (state().slow ?? []).filter(kept((entry) => readWait(block, entry))),
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
   * session, "skip" when some of its hours are left uncounted (slow, or in their slow wait) while
   * its pool goes on, or undefined once the block is counted. A count that fails in Postgres rests
   * only its pool. Counted `again`, a block takes every hour of it, settled ones included.
   */
  const countBlock = async (
    block: CaptureBlock,
    again = false,
  ): Promise<CaptureHoursAutoStop | "rest" | "skip" | undefined> => {
    try {
      return await countBlockOnce(block, again);
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
  /**
   * A recounted hour whose count ran out its limit leaves the recount pending, as a mark leaves it:
   * its old count is suspect, the summary reads it row by row, and the pending path's slow waits,
   * longer retries and giving up take it from here, so the recount's cycle can end.
   */
  const leavePending = (pool: string, hour: string) =>
    boundedRead(
      db,
      left,
      async () => {
        // Below the statement's own limit, which a nearly spent session makes as short as 50 ms.
        const limit = Math.max(50, Math.min(captureHoursReadLimitMs, Math.floor(left())));
        await db.query("SELECT set_config('lock_timeout',$1,true)", [
          `${Math.max(1, Math.min(100, Math.floor(limit / 2)))}ms`,
        ]);
        await db.query(
          "UPDATE basalt_model_capture_hours SET checked_at='-infinity' WHERE pool=$1 AND hour=$2",
          [pool, hour],
        );
      },
      captureHoursReadLimitMs,
      true,
    ).catch((error: unknown) => {
      // A mark holding the row is making it pending already; a session out of time leaves the hour
      // in the cycle for the next one. Neither is the tick's failure.
      const code = postgresCode(error);
      if (code !== "55P03" && code !== "57014") throw error;
    });
  /** The hours the last block counted one by one: a skipped block's pending shrinks by them. */
  let countedInBlock = 0;
  const countBlockOnce = async (
    block: CaptureBlock,
    again: boolean,
  ): Promise<CaptureHoursAutoStop | "rest" | "skip" | undefined> => {
    if (stopped()) return "handover";
    if (left() <= 0) return "budget";
    progress.working = block.pool;
    // A block holding an hour in its slow wait goes hour by hour without that hour.
    const waits = slowWaiting();
    const held = (hour: string) => waits.has(`${block.pool}|${hour}`);
    const holds = hoursOf(block).some(held);
    if (!isSplit(block) && !holds) {
      const started = performance.now();
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
      // A mark holds one of its rows: the block waits pending for a later session.
      if (result.kind === "busy") return "skip";
      if (result.kind === "lock") {
        progress.stopHour = block.from;
        return "lock";
      }
      if (result.kind === "slow") {
        if (again) await leavePending(block.pool, block.from);
        slowHour(block, block.from, result.readMs, "count", performance.now() - started);
        return "skip";
      }
      // Past its own limit: from now on hour by hour, starting in this session if time is left.
      markSplit(block);
    }
    // Counted again, every hour; else only the hours without a settled count. A statement timeout
    // in that read is this pool's own: its first hour waits like a slow hour and the pool goes on,
    // unless the session's budget cut the read short, which is a budget stop.
    let hours: string[];
    if (again) hours = hoursOf(block);
    else {
      // A read that ran out its limit is not run again until its own wait ends.
      if (readWaiting(block)) return "skip";
      const limit = Math.floor(left());
      const started = performance.now();
      try {
        hours = await read(() => pendingHoursOf(db, block));
        readAnswered(block);
      } catch (error) {
        if (postgresCode(error) !== "57014") throw error;
        if (limit < captureHoursReadLimitMs) return "budget";
        slowHour(
          block,
          startOf(block),
          captureHoursReadLimitMs,
          "read",
          performance.now() - started,
        );
        return "skip";
      }
    }
    let skipped = false;
    countedInBlock = 0;
    for (const hour of hours) {
      if (held(hour)) {
        skipped = true;
        continue;
      }
      if (stopped()) return "handover";
      if (left() <= 0) return "budget";
      const started = performance.now();
      const result = await countCaptureHour(db, block.pool, hour, left, bounds.countLimitMs);
      if (result.kind === "budget") return "budget";
      if (result.kind === "busy") {
        skipped = true;
        continue;
      }
      if (result.kind === "lock") {
        progress.stopHour = hour;
        return "lock";
      }
      if (result.kind === "slow" || result.kind === "split") {
        // That hour waits; the block's other hours, and the pool's other blocks, go on, unless this
        // was the pool's second slow count this session, which ends its turn.
        if (again) await leavePending(block.pool, hour);
        slowHour(block, hour, result.readMs, "count", performance.now() - started);
        if (resting.has(block.pool)) return "skip";
        skipped = true;
        continue;
      }
      counted(
        { pool: block.pool, from: hour, to: new Date(Date.parse(hour) + hourMs).toISOString() },
        true,
      );
      countedInBlock++;
    }
    if (skipped) return "skip";
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
  // Each pool's pending blocks the session reached and left waiting, never to be counted this session.
  const skips = new Map<string, number>();
  /** Pending blocks while the session has budget left. */
  const fill = async () => {
    while (left() > 0) {
      const block = nextPending();
      if (!block) return undefined;
      countedInBlock = 0;
      const stop = await countBlock(block);
      update({ nextPool: block.pool });
      if (stop !== undefined) {
        // Not finished: some of it waits, the budget ran out inside it, or it stopped. The block
        // stays pending, less the hours it did count.
        const was = pending.get(block.pool)!;
        pending.set(block.pool, { ...was, hours: Math.max(0, was.hours - countedInBlock) });
        tally();
        if (stop === "skip") {
          skips.set(block.pool, (skips.get(block.pool) ?? 0) + 1);
          continue;
        }
        if (stop === "rest") continue;
        return stop;
      }
      const was = pending.get(block.pool)!;
      pending.set(block.pool, {
        blocks: Math.max(0, was.blocks - 1),
        hours: Math.max(0, was.hours - (block.missing ?? 0)),
      });
      tally();
    }
    return undefined;
  };
  /**
   * Stuck hours whose wait is over, first, while the session's budget is whole: each alone, under
   * the next of its retry limits, and only when the session has that much left, else in a later
   * session. Counted, it says the limit and the time it took. Slow under its last limit, it is given
   * up: it stays stuck, held from counting, and is not tried again.
   */
  const retryStuck = async (): Promise<CaptureHoursAutoStop | undefined> => {
    const due = (state().slow ?? []).filter(
      (entry) =>
        isStuck(entry) &&
        entry.gaveUp !== true &&
        known.has(entry.pool) &&
        Date.parse(entry.until) <= now(),
    );
    const last = bounds.stuckRetryLimitsMs.length - 1;
    for (const entry of due) {
      // A pool resting after an error, or whose turn this session has ended, waits like its counts.
      if (waiting().has(entry.pool) || resting.has(entry.pool)) continue;
      const step = Math.min(entry.retries ?? 0, last);
      if (stopped()) return "handover";
      // A margin over the limit, so the count's own limit is never cut short of it and read as the
      // session's budget. The last step takes what the session has left, up to its limit, as long as
      // that is more than the step before: the session's own reads before it may leave less.
      const room = Math.floor(left()) - stuckRetryMarginMs;
      const limitMs =
        step === last
          ? Math.min(bounds.stuckRetryLimitsMs[last]!, room)
          : bounds.stuckRetryLimitsMs[step]!;
      const before = step === last ? (bounds.stuckRetryLimitsMs[last - 1] ?? 0) : 0;
      if (room < limitMs || limitMs <= before) continue;
      const { pool, hour } = entry;
      const alone = { pool, from: hour, to: new Date(Date.parse(hour) + hourMs).toISOString() };
      progress.working = pool;
      const started = performance.now();
      let result: Awaited<ReturnType<typeof countCaptureHour>>;
      try {
        result = await countCaptureHour(db, pool, hour, left, limitMs);
      } catch (error) {
        const code = poolCountFailure(error);
        if (code === undefined) {
          progress.working = "";
          throw error;
        }
        console.error("POOL_CAPTURE_HOURS_COUNT_FAILED", { code });
        failedPool(pool);
        continue;
      }
      const elapsedMs = Math.round(performance.now() - started);
      if (result.kind === "budget") return undefined;
      if (result.kind === "busy") continue;
      if (result.kind === "lock") {
        progress.stopHour = hour;
        return "lock";
      }
      if (result.kind === "done") {
        console.error("POOL_CAPTURE_HOURS_STUCK_COUNTED", {
          pool: ordinal(pool),
          hour,
          limitMs,
          elapsedMs,
          readMs: result.readMs,
        });
        counted(alone, true);
        // A pending block that is only this hour, as the settle horizon can cut one, is done: never
        // counted again whole in this session. A longer block reads its pending hours afresh.
        const queue = queues.get(pool) ?? [];
        const inside = (queued: CaptureBlock) =>
          Date.parse(queued.from) >= Date.parse(alone.from) &&
          Date.parse(queued.to) <= Date.parse(alone.to);
        const finished = queue.filter(inside);
        if (finished.length) {
          queues.set(
            pool,
            queue.filter((queued) => !inside(queued)),
          );
          const was = pending.get(pool);
          if (was)
            pending.set(pool, {
              blocks: Math.max(0, was.blocks - finished.length),
              hours: Math.max(
                0,
                was.hours - finished.reduce((sum, queued) => sum + (queued.missing ?? 1), 0),
              ),
            });
          tally();
        }
        continue;
      }
      slowHour(alone, hour, result.readMs, "count", elapsedMs);
      // Given up only after a try under the full last limit: one the session cut shorter stays at
      // the last step, to be tried again after its wait.
      const gaveUp = step === last && limitMs >= bounds.stuckRetryLimitsMs[last]!;
      if (gaveUp)
        console.error("POOL_CAPTURE_HOURS_GAVE_UP", {
          pool: ordinal(pool),
          hour,
          limitMs,
          elapsedMs,
        });
      const mine = (item: { pool: string; hour?: string; limit?: "read" }) =>
        item.pool === pool && item.hour === hour && item.limit === undefined;
      update({
        slow: (state().slow ?? []).map((item) =>
          mine(item)
            ? { ...item, retries: (entry.retries ?? 0) + 1, ...(gaveUp ? { gaveUp: true } : {}) }
            : item,
        ),
        ...(gaveUp
          ? {
              stuck: (state().stuck ?? []).map((item) =>
                mine(item) ? { ...item, gaveUp: true } : item,
              ),
            }
          : {}),
      });
    }
    return undefined;
  };
  /**
   * What the session has left after pending blocks counts the remapped pools again, each newest
   * first. A pool is done once no count of it predates its remap; a block left with an hour in its
   * slow wait keeps its pool for a later session.
   */
  const again = async (): Promise<CaptureHoursAutoStop | undefined> => {
    for (const pool of Object.keys(state().recount ?? {})) {
      const tried = new Set<string>();
      for (let more = true; more;) {
        if (waiting().has(pool) || resting.has(pool)) break;
        if (stopped()) return "handover";
        if (left() <= 0) return "budget";
        const cycle = state().recount?.[pool];
        if (!validRecount(cycle)) {
          update({
            recount: Object.fromEntries(
              Object.entries(state().recount ?? {}).filter(([name]) => name !== pool),
            ),
          });
          break;
        }
        const listed = await read(() =>
          recountBlocks(db, pool, cycle.before, bounds.lookbackHours),
        );
        if (!listed.length) {
          // This cycle is done: the next starts from the newest change, or the pool leaves.
          const { [pool]: _done, ...others } = state().recount ?? {};
          update({ recount: cycle.next ? { ...others, [pool]: { before: cycle.next } } : others });
          tried.clear();
          continue;
        }
        const blocks = listed.filter((block) => !tried.has(block.from));
        more = blocks.length > 0;
        for (const block of blocks) {
          tried.add(block.from);
          countedInBlock = 0;
          const stop = await countBlock(block, true);
          if (stop === "rest") {
            more = false;
            break;
          }
          if (stop !== undefined && stop !== "skip") return stop;
        }
      }
    }
    return undefined;
  };
  const retried = await retryStuck();
  if (retried) return retried;
  const rest = await fill();
  if (rest) return rest;
  const later = await again();
  if (later) return later;
  const held = waiting();
  // Pending blocks this session never reached, past the ones it left waiting: the budget stopped it,
  // whether they were still queued or past the plan's listed blocks. What is left past them is only
  // hours in their slow wait, which no session may count yet.
  const unserved = pools.some(
    (pool) =>
      pending.get(pool.pool)!.blocks > (skips.get(pool.pool) ?? 0) &&
      !held.has(pool.pool) &&
      !resting.has(pool.pool),
  );
  if (unserved) return "budget";
  if (pools.some((pool) => pending.get(pool.pool)!.blocks > 0)) return slowed ? "slow" : "waiting";
  return "complete";
}
