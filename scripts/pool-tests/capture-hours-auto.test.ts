import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import {
  captureHoursAutoKey,
  captureHoursInspect,
  captureHoursStuckPools,
  captureHoursTick,
  type CaptureHoursAutoState,
} from "../../src/pool/model-history/capture-hours-auto.ts";
import { countBlockStatement } from "../../src/pool/model-history/capture-hours-count.ts";
import { recountBlocks } from "../../src/pool/model-history/capture-hours-plan.ts";
import { captureHoursLockClass } from "../../src/pool/model-history/capture-hours-schema.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { at, captureFixture, lookbackHours, memoryStorage } from "./capture-hours-fixture.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryPrices } from "./usage-summary-fixture.ts";

const minute = 60_000;
type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];

/** The pool's hours over the fixture's lookback, and how many of them have a settled count. */
async function counted(f: Fixture, pool: string, hours = lookbackHours) {
  const row = (
    await f.db.query(
      `SELECT count(*)::int AS hours, count(s.hour)::int AS settled
      FROM generate_series(date_trunc('hour',now() - interval '2 hours','UTC') - $2 * interval '1 hour',
        date_trunc('hour',now() - interval '2 hours','UTC') - interval '1 hour', interval '1 hour') h(at)
      LEFT JOIN basalt_model_capture_hours s ON s.pool=$1 AND s.hour=h.at
        AND s.checked_at >= s.hour + interval '2 hours'`,
      [pool, hours],
    )
  ).rows[0]!;
  return { hours: Number(row.hours), settled: Number(row.settled) };
}

/** The settle horizon, as the database computes it. */
async function horizon(f: Fixture) {
  const row = await f.db.query("SELECT date_trunc('hour',now() - interval '2 hours','UTC') AS at");
  return (row.rows[0]!.at as Date).getTime();
}
const hour = 3_600_000;
const block = 6 * hour;
const key = (at: number) => new Date(at).toISOString().replace(".000Z", "Z");

/**
 * The test's clock, as production spends it: a count of a range of `slow`'s pool holding its hour
 * (or any of its ranges, without one) costs `cost.ms`, never more than the limit it was given, past
 * which Postgres cancels it; with `blocks`, only a range of more than one hour costs it. `fail`
 * makes every count of its pool fail outright. `counts` records every count's range.
 */
function timed(
  db: HistoryDatabase,
  clock: { at: number },
  slow?: { pool: string; hour?: string; cost: { ms: number }; blocks?: boolean },
  /** A pool whose counts fail as Postgres fails one statement, or how every count fails. */
  fail?: string | { pool?: string; code: string; severity?: string },
  counts: { pool: string; from: number; to: number }[] = [],
) {
  let limit = Number.POSITIVE_INFINITY;
  return {
    query: async (text: string, values?: unknown[]) => {
      if (text.startsWith("SELECT set_config('statement_timeout'"))
        limit = Number.parseInt(String(values![0]));
      // As Postgres fails a statement: with its SQLSTATE.
      const failing =
        typeof fail === "string" ? { pool: fail, code: "XX000", severity: "ERROR" } : fail;
      if (
        text === countBlockStatement &&
        failing &&
        (failing.pool === undefined || values![0] === failing.pool)
      )
        throw Object.assign(new Error("fixture failure"), {
          code: failing.code,
          ...(failing.severity ? { severity: failing.severity } : {}),
        });
      const from = text === countBlockStatement ? Date.parse(String(values![1])) : 0;
      const to = text === countBlockStatement ? Date.parse(String(values![2])) : 0;
      if (text === countBlockStatement) counts.push({ pool: String(values![0]), from, to });
      if (
        text === countBlockStatement &&
        slow &&
        values![0] === slow.pool &&
        (slow.hour === undefined ||
          (Date.parse(slow.hour) >= from && Date.parse(slow.hour) < to)) &&
        (!slow.blocks || to - from > hour)
      ) {
        clock.at += Math.min(slow.cost.ms, limit);
        if (limit < slow.cost.ms)
          throw Object.assign(new Error("canceling statement due to statement timeout"), {
            code: "57014",
          });
      }
      return db.query(text, values);
    },
  } satisfies HistoryDatabase;
}

test("a pool is counted to its settle horizon by ticks alone, each session within its budget", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.native(at(20, minute));
    await c.ready();
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    let ticks = 0;
    let state: CaptureHoursAutoState = {};
    // Thirteen or fourteen six-hour blocks, wherever the horizon falls in the six-hour grid: more
    // than two ticks' budget. A multiple of six would make it twelve on the grid, which two take.
    const hours = lookbackHours + 6;
    for (; ticks < 100; ticks++) {
      state = await captureHoursTick(storage, (work) => work(f.db), {
        now: () => (clock += 1),
        bounds: { sessionMs: 12, lookbackHours: hours },
      });
      for (const session of state.sessions ?? [])
        assert.ok(session.ms <= 12 + 4, `a session took ${session.ms} ms of a 12 ms budget`);
      if (state.lastStop === "complete") break;
      clock += 5 * minute;
    }
    assert.ok(ticks > 2, `it took ${ticks} ticks`);
    const done = await counted(f, c.poolId, hours);
    assert.equal(done.hours, hours);
    assert.deepEqual(done, { hours: done.hours, settled: done.hours }, "fully counted");
    assert.equal(state.pendingHours, 0);
    assert.equal(state.pendingBlocks, 0);
    assert.equal(state.pools, 0);
    assert.deepEqual([...(await c.coverage(at(0), at(24))).incomplete!], []);
  });
});

test("the hourly ceiling holds over any sliding hour, across ticks", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    const storage = memoryStorage();
    const start = Date.parse("2026-02-01T00:00:00Z");
    let clock = start;
    const now = () => (clock += 1);
    // Thirty days of blocks: more than one session's budget takes.
    const bounds = { hourMs: 300, sessionMs: 200, lookbackHours: 30 * 24 };
    const first = await captureHoursTick(storage, (work) => work(f.db), { now, bounds });
    const spent = (state: CaptureHoursAutoState, from: number) =>
      (state.sessions ?? []).filter((s) => s.at >= from).reduce((sum, s) => sum + s.ms, 0);
    assert.equal(first.sessions?.length, 2);
    assert.ok(spent(first, start) <= 300 + 3, `${spent(first, start)} ms in its first hour`);
    clock = start + 59 * minute;
    const second = await captureHoursTick(storage, (work) => work(f.db), { now, bounds });
    assert.equal(second.lastStop, "ceiling", "59 minutes later the hour is still spent");
    clock = start + 61 * minute;
    const third = await captureHoursTick(storage, (work) => work(f.db), { now, bounds });
    assert.notEqual(third.lastStop, "ceiling", "an hour later it runs again");
  });
});

test("a code handover ends the tick at the next hour boundary, with every counted hour committed", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    // Hours committed: a COMMIT right after a count, never a read's.
    let commits = 0,
      counting = false;
    const db: HistoryDatabase = {
      query: async (text, values) => {
        const result = await f.db.query(text, values);
        if (text === "COMMIT" && counting) commits++;
        counting = text === countBlockStatement;
        return result;
      },
    };
    // The three blocks before the settle horizon, as the database computes it: the newest one
    // ends at the horizon, the two before it are whole.
    const end = await horizon(f);
    const newest: string[] = [];
    for (let at = Math.floor((end - hour) / block) * block - 2 * block; at < end; at += hour)
      newest.push(key(at));
    const state = await captureHoursTick(memoryStorage(), (work) => work(db), {
      stopped: () => commits >= 3,
      bounds: { lookbackHours },
    });
    assert.equal(state.lastStop, "handover");
    // The newest blocks come first, so the overview's usual windows are proven first.
    assert.deepEqual(Object.keys(await c.stored()), newest);
    // No transaction is left open behind it.
    await f.db.query("BEGIN");
    await f.db.query("ROLLBACK");
  });
});

test("a count past its own limit is slow: only its pool waits, three in a row is stuck and loud once, and it is retried every wait", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.native(at(1, minute), true);
    await c.ready();
    // Newest first: the pool's first block holds the hour before the settle horizon. Its block
    // runs out its limit and splits; then that hour, alone, runs out its own and is slow.
    const slowHour = key((await horizon(f)) - hour);
    const cost = { ms: 5_000 };
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const storage = memoryStorage();
    // The slow pool's turn comes first, so the other pool counts the same hours after it stops.
    await storage.put(captureHoursAutoKey, { nextPool: c.otherId });
    const tick = () =>
      captureHoursTick(
        storage,
        (work) => work(timed(f.db, clock, { pool: c.poolId, hour: slowHour, cost })),
        { now: () => clock.at, bounds: { lookbackHours } },
      );
    const first = await tick();
    const other = await counted(f, c.otherId);
    assert.equal(other.settled, other.hours, "the other pool went on in the same tick");
    assert.equal(first.lastStop, "slow");
    assert.deepEqual(
      [first.lastHour, first.lastHourPool],
      [slowHour, c.poolId],
      "another pool counting the same hour keeps the slow pool's stop hour",
    );
    assert.equal(first.pausedUntil, undefined, "a slow count never pauses the tick");
    assert.deepEqual(first.slow, [
      {
        pool: c.poolId,
        hour: slowHour,
        count: 1,
        until: new Date(clock.at + 10 * minute).toISOString(),
      },
    ]);
    clock.at += 5 * minute;
    const waiting = await tick();
    assert.equal(waiting.lastStop, "waiting");
    assert.equal(waiting.slow?.[0]?.count, 1, "not tried while it waits");
    clock.at += 5 * minute + 1_000;
    assert.equal((await tick()).slow?.[0]?.count, 2);
    clock.at += 10 * minute + 1_000;
    const stuck = await tick();
    assert.deepEqual(captureHoursStuckPools(stuck), [c.poolId]);
    assert.deepEqual(stuck.stuck, [
      { pool: c.poolId, reason: "slow", hour: slowHour, retryAt: stuck.slow![0]!.until },
    ]);
    const inspected = captureHoursInspect(stuck);
    assert.deepEqual([inspected.lastHour, inspected.lastHourReadMs], [slowHour, 1_000]);
    clock.at += 10 * minute + 1_000;
    assert.equal((await tick()).slow?.[0]?.count, 4, "retried after its wait");
    const loud = logged.mock.calls.filter(
      (call) => call.arguments[0] === "POOL_CAPTURE_HOURS_STUCK",
    );
    assert.deepEqual(
      loud.map((call) => call.arguments[1]),
      [{ reason: "slow", hour: slowHour }],
      "loud once, naming the hour",
    );
    // Once the hour fits, the tick after the wait counts it and clears the pool.
    cost.ms = 0;
    clock.at += 10 * minute + 1_000;
    const done = await tick();
    assert.deepEqual(captureHoursStuckPools(done), []);
    assert.deepEqual(done.slow, []);
    const pool = await counted(f, c.poolId);
    assert.equal(pool.settled, pool.hours);
  });
});

test("a count the session's budget cuts short of its own limit is a budget stop, never slow", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const state = await captureHoursTick(
      memoryStorage(),
      (work) => work(timed(f.db, clock, { pool: c.poolId, cost: { ms: 700 } })),
      { now: () => clock.at, bounds: { sessions: 1, sessionMs: 500, lookbackHours } },
    );
    assert.equal(state.lastStop, "budget");
    assert.equal(state.pausedUntil, undefined);
    assert.deepEqual(state.slow ?? [], []);
    assert.deepEqual(captureHoursStuckPools(state), []);
  });
});

test("a pool another session holds is a lock stop: the tick never waits, pauses an hour, and six in a row is stuck", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    const holder = new pg.Client({ connectionString: url.toString() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [
        captureHoursLockClass,
        c.poolId,
      ]);
      let clock = Date.parse("2026-02-01T00:00:00Z");
      const storage = memoryStorage();
      const tick = () =>
        captureHoursTick(storage, (work) => work(f.db), {
          now: () => clock,
          bounds: { lookbackHours },
        });
      const started = performance.now();
      const first = await tick();
      assert.ok(performance.now() - started < 1_500, "it never queues behind the holder");
      assert.equal(first.lastStop, "lock");
      assert.equal(first.pausedUntil, new Date(clock + 3_600_000).toISOString());
      assert.deepEqual(first.repeat, { pool: c.poolId, reason: "lock", count: 1 });
      assert.deepEqual(await c.stored(), {}, "a refused count writes nothing");
      clock += 30 * minute;
      assert.deepEqual(await tick(), first, "paused: the tick does nothing");
      let state = first;
      for (let n = 2; n <= 6; n++) {
        clock += 61 * minute;
        state = await tick();
      }
      assert.deepEqual(state.stuck, [
        { pool: c.poolId, reason: "lock", retryAt: state.pausedUntil },
      ]);
      assert.deepEqual(captureHoursStuckPools(state), [c.poolId]);
      assert.deepEqual(
        logged.mock.calls
          .filter((call) => call.arguments[0] === "POOL_CAPTURE_HOURS_STUCK")
          .map((call) => call.arguments[1]),
        [{ reason: "lock" }],
        "loud once",
      );
      // A stuck or paused tick leaves the overview readable, the hours it never counted read row by
      // row as before v17.
      const summary = await poolUsageSummary(
        f.db,
        { pool, from: at(-24 * 30), to: at(24), by: "model", authority: c.authority },
        async () => ({ prices: summaryPrices, issues: [] }),
        Date.parse(at(24)),
      );
      assert.equal(summary.homeCapture.status, "unavailable");
      assert.equal(summary.partial, true);
      const read = await c.coverage(at(0), at(24));
      assert.deepEqual([...read.incomplete!], [], "the row check found every request");
      assert.deepEqual(
        read.ranges?.map((range) => [Date.parse(range.f), Date.parse(range.t)]),
        [[Date.parse(at(0)), Date.parse(at(24))]],
        "the uncounted day, row by row",
      );
      await holder.query("COMMIT");
      clock += 61 * minute;
      const done = await tick();
      assert.deepEqual(captureHoursStuckPools(done), []);
      assert.equal(done.repeat, undefined);
      assert.deepEqual([...(await c.coverage(at(0), at(24))).incomplete!], []);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  });
});

test("a pool whose count fails rests alone: six in a row is stuck and loud once, it is retried after each rest, and clears once it counts", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.native(at(0, minute), true);
    await c.ready();
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const storage = memoryStorage();
    let fail: string | undefined = c.poolId;
    const tick = () =>
      captureHoursTick(storage, (work) => work(timed(f.db, clock, undefined, fail)), {
        now: () => clock.at,
        bounds: { lookbackHours },
      });
    const first = await tick();
    assert.equal(first.pausedUntil, undefined, "the tick goes on");
    assert.equal(first.repeat, undefined, "the tick itself is not failing");
    assert.deepEqual(first.failing, [
      { pool: c.poolId, count: 1, until: new Date(clock.at + 3_600_000).toISOString() },
    ]);
    const other = await counted(f, c.otherId);
    assert.equal(other.settled, other.hours, "the other pool was counted in full");
    clock.at += 30 * minute;
    assert.equal((await tick()).failing?.[0]?.count, 1, "not tried while it rests");
    let state = first;
    for (let n = 2; n <= 6; n++) {
      clock.at += 61 * minute;
      state = await tick();
      assert.equal(state.failing?.[0]?.count, n, "retried after each rest");
    }
    assert.deepEqual(state.stuck, [
      { pool: c.poolId, reason: "error", retryAt: state.failing![0]!.until },
    ]);
    assert.deepEqual(captureHoursStuckPools(state), [c.poolId]);
    assert.deepEqual(
      logged.mock.calls
        .filter((call) => call.arguments[0] === "POOL_CAPTURE_HOURS_STUCK")
        .map((call) => call.arguments[1]),
      [{ reason: "error" }],
      "loud once",
    );
    // Its count works again: after the rest it counts, and nothing stays stuck.
    fail = undefined;
    clock.at += 61 * minute;
    const recovered = await tick();
    assert.deepEqual(captureHoursStuckPools(recovered), []);
    assert.deepEqual(recovered.failing, []);
    const mine = await counted(f, c.poolId);
    assert.equal(mine.settled, mine.hours);
  });
});

test("a pool whose every count fails never stops the others: over eight passes the healthy pool is counted in full", async (t) => {
  t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.native(at(0, minute), true);
    await c.ready();
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const storage = memoryStorage();
    // The failing pool's turn comes first, every pass.
    await storage.put(captureHoursAutoKey, { nextPool: c.otherId });
    for (let pass = 0; pass < 8; pass++) {
      await captureHoursTick(storage, (work) => work(timed(f.db, clock, undefined, c.poolId)), {
        now: () => clock.at,
        bounds: { lookbackHours },
      });
      clock.at += 5 * minute;
    }
    const healthy = await counted(f, c.otherId);
    assert.equal(healthy.settled, healthy.hours, "the healthy pool's every hour was counted");
    assert.equal((await counted(f, c.poolId)).settled, 0);
  });
});

test("a tick that fails before reaching any pool pauses whole, and six in a row is stuck naming none", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const storage = memoryStorage();
    let state = await captureHoursTick(storage, () => Promise.reject(new Error("connect")), {
      now: () => clock.at,
    });
    assert.equal(state.lastStop, "error");
    assert.deepEqual(state.repeat, { pool: "", reason: "error", count: 1 });
    assert.equal(state.pausedUntil, new Date(clock.at + 3_600_000).toISOString());
    for (let n = 1; n < 6; n++) {
      clock.at += 61 * minute;
      state = await captureHoursTick(storage, () => Promise.reject(new Error("connect")), {
        now: () => clock.at,
      });
    }
    assert.deepEqual(captureHoursStuckPools(state), [""]);
    assert.equal(captureHoursInspect(state).stuck[0]?.pool, null);
    assert.ok(
      logged.mock.calls.some((call) => call.arguments[0] === "POOL_CAPTURE_HOURS_TICK_FAILED"),
    );
    clock.at += 61 * minute;
    const recovered = await captureHoursTick(storage, (work) => work(f.db), {
      now: () => clock.at,
      bounds: { lookbackHours },
    });
    assert.deepEqual(captureHoursStuckPools(recovered), []);
    assert.equal(recovered.lastStop, "complete");
  });
});

/** Every hour's count time, by hour, oldest hour first. */
async function checkedAt(f: Fixture, pool: string) {
  return (
    await f.db.query(
      "SELECT hour, checked_at FROM basalt_model_capture_hours WHERE pool=$1 ORDER BY hour",
      [pool],
    )
  ).rows.map((row) => [(row.hour as Date).toISOString(), (row.checked_at as Date).getTime()]);
}

/** Every count settled long ago, the oldest hour counted longest ago. */
const aged = (f: Fixture) =>
  f.db.query("UPDATE basalt_model_capture_hours SET checked_at=hour + interval '3 hours'");

/** A clock that every count moves by `ms`, and a database that records each count's range. */
function costly(f: Fixture, ms: number) {
  const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
  const counts: { pool: string; from: number; to: number }[] = [];
  const db: HistoryDatabase = {
    query: (text, values) => {
      if (text === countBlockStatement) {
        clock.at += ms;
        counts.push({
          pool: String(values![0]),
          from: Date.parse(String(values![1])),
          to: Date.parse(String(values![2])),
        });
      }
      return f.db.query(text, values);
    },
  };
  return { clock, counts, db };
}

test("older blocks are reached when the newest pending ones overflow every session, the pools in turn", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.native(at(0, minute), true);
    await c.ready();
    // Thirty days counted long ago, then the newest five days' counts gone: 20 pending blocks a
    // pool, far more than a session's pending share takes.
    const lookback = 30 * 24;
    await c.fill(lookback);
    await aged(f);
    const end = await horizon(f);
    await f.db.query("DELETE FROM basalt_model_capture_hours WHERE hour >= $1", [
      new Date(end - 5 * 24 * hour).toISOString(),
    ]);
    // Each count costs 10 ms of a 100 ms session: about ten blocks, at most 7.5 of them pending.
    const { clock, counts, db } = costly(f, 10);
    const storage = memoryStorage();
    const old = (count: { from: number }) => count.from < end - 5 * 24 * hour;
    for (let pass = 1; pass <= 6; pass++) {
      const before = counts.length;
      await captureHoursTick(storage, (work) => work(db), {
        now: () => clock.at,
        bounds: { lookbackHours: lookback, sessions: 1, sessionMs: 100 },
      });
      const these = counts.slice(before);
      assert.ok(these.some(old), `pass ${pass} recounted an older block`);
      assert.ok(
        these.filter((count) => !old(count)).length <= 8,
        `pass ${pass}: the pending share stays within three quarters of the session`,
      );
      clock.at += 5 * minute;
    }
    const pending = counts.filter((count) => !old(count));
    // The pools in turn, newest block first for each.
    const turns = pending.map((count) => count.pool);
    for (let n = 1; n < Math.min(turns.length, 12); n++)
      assert.notEqual(turns[n], turns[n - 1], "no pool waits for another to finish");
    for (const pool of [c.poolId, c.otherId]) {
      const mine = pending.filter((count) => count.pool === pool).map((count) => count.from);
      assert.deepEqual(
        mine,
        [...mine].sort((a, b) => b - a),
        "each pool's newest block first",
      );
    }
    assert.ok(counts.filter(old).length >= 12, "six passes reached at least twelve older blocks");
  });
});

test("with the session to spare, the recount takes every block counted over an hour ago, and none counted since", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    await c.fill();
    // Just counted: nothing is recounted.
    const fresh = costly(f, 0);
    await captureHoursTick(c.storage, (work) => work(fresh.db), { bounds: { lookbackHours } });
    assert.deepEqual(fresh.counts, [], "a block counted within the last hour is not recounted");
    await aged(f);
    const before = await checkedAt(f, c.poolId);
    const state = await captureHoursTick(c.storage, (work) => work(f.db), {
      bounds: { lookbackHours },
    });
    assert.equal(state.lastStop, "complete");
    // Read at the plan: the oldest settled count before this tick's recount.
    assert.equal(
      state.stalestCheckedAt,
      new Date(Date.parse(String(before[0]![0])) + 3 * 3_600_000).toISOString(),
    );
    const after = await checkedAt(f, c.poolId);
    assert.ok(
      after.every(([, at], n) => at !== before[n]![1]),
      "every hour was recounted",
    );
    assert.equal(state.recountPosition?.pool, c.poolId);
    assert.equal(captureHoursInspect(state).recountPosition?.block, state.recountPosition?.block);
    const next = await captureHoursTick(c.storage, (work) => work(f.db), {
      bounds: { lookbackHours },
    });
    assert.ok(Date.parse(next.stalestCheckedAt!) > Date.parse(state.stalestCheckedAt!));
  });
});

test("a block past its own limit splits into hours, counted in the same pass, and the tick moves on to the next block", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    const end = await horizon(f);
    const newest = Math.floor((end - hour) / block) * block;
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const counts: { pool: string; from: number; to: number }[] = [];
    const storage = memoryStorage();
    // The newest block, whole, costs 5 s; each of its hours alone costs nothing.
    const slow = { pool: c.poolId, hour: key(newest), cost: { ms: 5_000 }, blocks: true };
    const state = await captureHoursTick(
      storage,
      (work) => work(timed(f.db, clock, slow, undefined, counts)),
      { now: () => clock.at, bounds: { lookbackHours } },
    );
    assert.deepEqual(state.split, [{ pool: c.poolId, blocks: [key(newest)] }]);
    assert.deepEqual(state.slow ?? [], [], "a split block is not slow");
    const ranges = counts.map((count) => [count.from, count.to]);
    // Tried whole once, then hour by hour, newest first; then the next block, whole.
    const singles: number[][] = [];
    for (let at = end - hour; at >= newest; at -= hour) singles.push([at, at + hour]);
    assert.deepEqual(ranges.slice(0, singles.length + 2), [
      [newest, end],
      ...singles,
      [newest - block, newest],
    ]);
    const stored = await c.stored();
    for (let at = newest; at < end; at += hour) assert.equal(stored[key(at)], 0, key(at));
    // Never whole again: a recount of it goes hour by hour too.
    await aged(f);
    const later = counts.length;
    await captureHoursTick(storage, (work) => work(timed(f.db, clock, slow, undefined, counts)), {
      now: () => clock.at + 2 * hour,
      bounds: { lookbackHours },
    });
    const recounted = counts.slice(later).filter((count) => count.from >= newest);
    assert.ok(recounted.length > 0, "the split block was recounted");
    assert.ok(
      recounted.every((count) => count.to - count.from === hour),
      "hour by hour",
    );
  });
});

test("the tick waits while v17 is not applied", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    await f.db.query(
      "DELETE FROM basalt_model_history_migrations WHERE name='model_request_history_v17_capture_hours'",
    );
    const state = await captureHoursTick(memoryStorage(), (work) => work(f.db));
    assert.equal(state.lastStop, "not_applied");
    assert.deepEqual(await c.stored(), {});
  });
});

test("the tick's plan runs under its own 3 s limit, and its other reads under 1 s", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    await c.fill();
    await aged(f);
    let limit: number | undefined;
    const reads: { text: string; limit?: number }[] = [];
    const db: HistoryDatabase = {
      query: (text, values) => {
        if (text.startsWith("BEGIN")) limit = undefined;
        if (text.startsWith("SELECT set_config('statement_timeout'"))
          limit = Number.parseInt(String(values![0]));
        if (/basalt_model_capture_hours s|basalt_model_usage_people_ready p/.test(text))
          reads.push({ text, limit });
        return f.db.query(text, values);
      },
    };
    await captureHoursTick(c.storage, (work) => work(db), { bounds: { lookbackHours } });
    const kinds = ["usage_people_ready p", "min(s.checked_at)", "DISTINCT ON (o.pool, o.block)"];
    for (const kind of kinds)
      assert.ok(
        reads.some((read) => read.text.includes(kind)),
        `the tick read ${kind}`,
      );
    // The plan, whose cost grows with the pools, under its own 3 s; every other read under 1 s.
    for (const read of reads.filter((entry) => entry.text !== countBlockStatement)) {
      const plan = read.text.includes("usage_people_ready p");
      assert.ok(
        read.limit !== undefined &&
          read.limit <= (plan ? 3_000 : 1_000) &&
          read.limit > (plan ? 1_000 : 0),
        `${read.text.slice(0, 60)}: ${read.limit}`,
      );
    }
  });
});

test("each pool keeps its own split blocks, bounded by its lookback, so no split block is retried whole", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.native(at(0, minute), true);
    await c.ready();
    const end = await horizon(f);
    const newest = Math.floor((end - hour) / block) * block;
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const counts: { pool: string; from: number; to: number }[] = [];
    const storage = memoryStorage();
    // A block of each pool is dense; and the state still names a block long past the lookback.
    const ancient = key(newest - 400 * 24 * hour);
    await storage.put(captureHoursAutoKey, {
      split: [{ pool: c.poolId, blocks: [ancient] }],
    });
    const dense = (pool: string, at: number) => ({
      pool,
      hour: key(at),
      cost: { ms: 5_000 },
      blocks: true,
    });
    const both: HistoryDatabase = timed(
      timed(f.db, clock, dense(c.otherId, newest - block), undefined, counts),
      clock,
      dense(c.poolId, newest),
    );
    const state = await captureHoursTick(storage, (work) => work(both), {
      now: () => clock.at,
      bounds: { lookbackHours },
    });
    const split = Object.fromEntries(
      (state.split ?? []).map((entry) => [entry.pool, entry.blocks]),
    );
    assert.deepEqual(split, { [c.poolId]: [key(newest)], [c.otherId]: [key(newest - block)] });
    // Recounted later, both go hour by hour: neither pool's split forgot the other's.
    await aged(f);
    const later = counts.length;
    await captureHoursTick(storage, (work) => work(both), {
      now: () => clock.at + 2 * hour,
      bounds: { lookbackHours },
    });
    for (const [pool, from] of [
      [c.poolId, newest],
      [c.otherId, newest - block],
    ] as const) {
      const mine = counts
        .slice(later)
        .filter((count) => count.pool === pool && count.from >= from && count.from < from + block);
      assert.ok(mine.length > 0, `${pool}'s split block was recounted`);
      assert.ok(
        mine.every((count) => count.to - count.from === hour),
        "hour by hour",
      );
    }
  });
});

test("a pending block that splits stops at the session's pending share between its hours", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    const end = await horizon(f);
    const newest = Math.floor((end - hour) / block) * block;
    // The block before the newest, a whole six hours, runs out its 1 s limit; each of its hours
    // then costs 400 ms of a 4 s session, whose pending share is 3 s: five fit, the sixth waits.
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const started = clock.at;
    let recountAt: number | undefined;
    const base = timed(f.db, clock, {
      pool: c.poolId,
      hour: key(newest - block),
      cost: { ms: 5_000 },
      blocks: true,
    });
    const db: HistoryDatabase = {
      query: async (text, values) => {
        if (
          text === countBlockStatement &&
          Date.parse(String(values![2])) - Date.parse(String(values![1])) === hour
        )
          clock.at += 400;
        if (text.includes("DISTINCT ON (o.pool, o.block)") && recountAt === undefined)
          recountAt = clock.at - started;
        return base.query(text, values);
      },
    };
    await captureHoursTick(memoryStorage(), (work) => work(db), {
      now: () => clock.at,
      bounds: { lookbackHours, sessions: 1, sessionMs: 4_000 },
    });
    assert.ok(recountAt !== undefined, "the recount had its turn");
    assert.ok(recountAt <= 3_000, `the pending share ran to ${recountAt} ms of 3,000`);
  });
});

test("counts older than the lookback are pruned, at most a thousand a pass, and never recounted", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    await c.fill();
    await aged(f);
    const end = await horizon(f);
    const first = end - lookbackHours * hour;
    // 1,500 hours counted while inside a longer lookback, long settled.
    await f.db.query(
      `INSERT INTO basalt_model_capture_hours (pool,hour,usage_requests,uncaptured_requests,checked_at)
      SELECT $1, h, 0, 0, h + interval '3 hours' FROM generate_series($2::timestamptz - interval '1500 hours',
        $2::timestamptz - interval '1 hour', interval '1 hour') h`,
      [c.poolId, new Date(first).toISOString()],
    );
    const old = async () =>
      Number(
        (
          await f.db.query(
            "SELECT count(*)::int AS n FROM basalt_model_capture_hours WHERE hour < $1",
            [new Date(first).toISOString()],
          )
        ).rows[0]!.n,
      );
    // The recount never takes them, though they were counted longest ago.
    const stale = await recountBlocks(
      f.db,
      [c.poolId],
      100,
      new Date().toISOString(),
      lookbackHours,
    );
    assert.ok(stale.length > 0);
    // A block of the lookback ends after it starts, past the lookback's first hour.
    assert.ok(
      stale.every(
        (block) => Date.parse(block.from) >= first && Date.parse(block.to) > Date.parse(block.from),
      ),
      "only blocks in the lookback",
    );
    const counts: { pool: string; from: number; to: number }[] = [];
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    await captureHoursTick(
      c.storage,
      (work) => work(timed(f.db, clock, undefined, undefined, counts)),
      {
        now: () => clock.at,
        bounds: { lookbackHours },
      },
    );
    assert.equal(await old(), 500, "one pass prunes a thousand");
    assert.ok(
      counts.every((count) => count.from >= first && count.to > count.from),
      "no count older than the lookback",
    );
    await captureHoursTick(c.storage, (work) => work(f.db), {
      now: () => clock.at + 5 * minute,
      bounds: { lookbackHours },
    });
    assert.equal(await old(), 0, "the next pass prunes the rest");
  });
});

test("a database-wide fault pauses the tick once with no pool named, while a pool's own error rests only that pool", async (t) => {
  t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.native(at(0, minute), true);
    await c.ready();
    for (const fail of [
      // A socket's code, never Postgres's.
      { code: "EPIPE" },
      // Read-only after a failover, on every pool.
      { code: "25006", severity: "ERROR" },
      // A stale shape.
      { code: "42703", severity: "ERROR" },
    ]) {
      const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
      const storage = memoryStorage();
      const tick = () =>
        captureHoursTick(storage, (work) => work(timed(f.db, clock, undefined, fail)), {
          now: () => clock.at,
          bounds: { lookbackHours },
        });
      const state = await tick();
      assert.equal(state.lastStop, "error", fail.code);
      assert.equal(state.pausedUntil, new Date(clock.at + 3_600_000).toISOString(), fail.code);
      assert.deepEqual(state.repeat, { pool: "", reason: "error", count: 1 }, fail.code);
      assert.deepEqual(state.failing ?? [], [], `${fail.code} rests no pool`);
      clock.at += 30 * minute;
      assert.deepEqual(await tick(), state, `${fail.code}: paused, the tick does nothing`);
    }
    // A pool's own error (an invalid value, an internal error) rests only that pool.
    for (const code of ["22P02", "XX000"]) {
      await f.db.query("DELETE FROM basalt_model_capture_hours");
      const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
      const state = await captureHoursTick(
        memoryStorage(),
        (work) => work(timed(f.db, clock, undefined, { pool: c.poolId, code, severity: "ERROR" })),
        { now: () => clock.at, bounds: { lookbackHours } },
      );
      assert.equal(state.pausedUntil, undefined, code);
      assert.deepEqual(
        state.failing?.map((entry) => entry.pool),
        [c.poolId],
        code,
      );
      const other = await counted(f, c.otherId);
      assert.equal(other.settled, other.hours, `${code}: the other pool was counted in full`);
    }
  });
});

test("a session the hourly ceiling would cut short of its plan read never starts", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    const at0 = Date.parse("2026-02-01T00:00:00Z");
    const storage = memoryStorage();
    // 70 ms of a 100 ms hour spent; the last plan read took 40 ms, more than the 30 ms left.
    await storage.put(captureHoursAutoKey, {
      planMs: 40,
      sessions: [{ at: at0 - minute, ms: 70 }],
    });
    let sessions = 0;
    const state = await captureHoursTick(
      storage,
      (work) => {
        sessions++;
        return work(f.db);
      },
      { now: () => at0, bounds: { lookbackHours, hourMs: 100 } },
    );
    assert.equal(state.lastStop, "ceiling");
    assert.equal(sessions, 0, "no session started");
    assert.equal(state.pausedUntil, undefined, "and the tick is not failing");
    // With more left than the plan takes, it runs.
    await storage.put(captureHoursAutoKey, {
      planMs: 20,
      sessions: [{ at: at0 - minute, ms: 70 }],
    });
    await captureHoursTick(
      storage,
      (work) => {
        sessions++;
        return work(f.db);
      },
      { now: () => at0, bounds: { lookbackHours, hourMs: 100 } },
    );
    assert.ok(sessions > 0);
  });
});

test("a statement timeout in a split block's own read is that pool's: it waits, or stops on budget, and never pauses the tick", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.native(at(0, minute), true);
    await c.ready();
    const end = await horizon(f);
    const newest = key(Math.floor((end - hour) / block) * block);
    // The pool's newest block is split, and the read of its pending hours times out.
    const timesOut: HistoryDatabase = {
      query: (text, values) => {
        if (text.includes("ORDER BY h.at DESC") && values![0] === c.poolId)
          return Promise.reject(
            Object.assign(new Error("canceling statement due to statement timeout"), {
              code: "57014",
              severity: "ERROR",
            }),
          );
        return f.db.query(text, values);
      },
    };
    const seeded = async () => {
      const storage = memoryStorage();
      await storage.put(captureHoursAutoKey, {
        nextPool: c.otherId,
        split: [{ pool: c.poolId, blocks: [newest] }],
      });
      return storage;
    };
    const state = await captureHoursTick(await seeded(), (work) => work(timesOut), {
      bounds: { lookbackHours },
    });
    assert.equal(state.pausedUntil, undefined, "the tick goes on");
    assert.deepEqual(
      state.slow?.map((entry) => [entry.pool, entry.hour]),
      [[c.poolId, newest]],
      "the pool waits like a slow hour",
    );
    const other = await counted(f, c.otherId);
    assert.equal(other.settled, other.hours, "the other pool was counted in full");
    // With the session's budget cutting that read short, it is a budget stop, never slow.
    await f.db.query("DELETE FROM basalt_model_capture_hours");
    const cut = await captureHoursTick(await seeded(), (work) => work(timesOut), {
      bounds: { lookbackHours, sessions: 1, sessionMs: 500 },
    });
    assert.equal(cut.pausedUntil, undefined);
    assert.deepEqual(cut.slow ?? [], []);
    assert.equal(cut.lastStop, "budget");
  });
});
