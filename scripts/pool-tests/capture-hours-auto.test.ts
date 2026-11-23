import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import {
  captureHoursInspect,
  captureHoursStuckPools,
  captureHoursTick,
  type CaptureHoursAutoState,
} from "../../src/pool/model-history/capture-hours-auto.ts";
import { countHourStatement } from "../../src/pool/model-history/capture-hours-count.ts";
import { captureHoursLockClass } from "../../src/pool/model-history/capture-hours-schema.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { at, captureFixture, lookbackHours, memoryStorage } from "./capture-hours-fixture.ts";
import { planCaptureHours } from "../../src/pool/model-history/capture-hours-plan.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryPrices } from "./usage-summary-fixture.ts";

const minute = 60_000;
type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];

/** The pool's hours over the fixture's lookback, and how many of them have a settled count. */
async function counted(f: Fixture, pool: string) {
  const row = (
    await f.db.query(
      `SELECT count(*)::int AS hours, count(s.hour)::int AS settled
      FROM generate_series(date_trunc('hour',now() - interval '2 hours','UTC') - $2 * interval '1 hour',
        date_trunc('hour',now() - interval '2 hours','UTC') - interval '1 hour', interval '1 hour') h(at)
      LEFT JOIN basalt_model_capture_hours s ON s.pool=$1 AND s.hour=h.at
        AND s.checked_at >= s.hour + interval '2 hours'`,
      [pool, lookbackHours],
    )
  ).rows[0]!;
  return { hours: Number(row.hours), settled: Number(row.settled) };
}

/**
 * The test's clock, as production spends it: a count of one of `slow`'s pool-hours costs
 * `cost.ms`, never more than the limit it was given, past which Postgres cancels it; `fail`
 * makes every count of its pool fail outright.
 */
function timed(
  db: HistoryDatabase,
  clock: { at: number },
  slow?: { pool: string; hour?: string; cost: { ms: number } },
  fail?: string,
) {
  let limit = Number.POSITIVE_INFINITY;
  return {
    query: async (text: string, values?: unknown[]) => {
      if (text.startsWith("SELECT set_config('statement_timeout'"))
        limit = Number.parseInt(String(values![0]));
      if (text === countHourStatement && values![0] === fail) throw new Error("fixture failure");
      if (
        text === countHourStatement &&
        slow &&
        values![0] === slow.pool &&
        (slow.hour === undefined || values![1] === slow.hour)
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
    for (; ticks < 100; ticks++) {
      state = await captureHoursTick(storage, (work) => work(f.db), {
        now: () => (clock += 1),
        bounds: { sessionMs: 20, lookbackHours },
      });
      for (const session of state.sessions ?? [])
        assert.ok(session.ms <= 20 + 3, `a session took ${session.ms} ms of a 20 ms budget`);
      if (state.lastStop === "complete") break;
      clock += 5 * minute;
    }
    assert.ok(ticks > 2, `it took ${ticks} ticks`);
    const done = await counted(f, c.poolId);
    assert.equal(done.hours, lookbackHours);
    assert.deepEqual(done, { hours: done.hours, settled: done.hours }, "fully counted");
    assert.equal(state.totalPendingHours, 0);
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
    const bounds = { hourMs: 30, sessionMs: 20, lookbackHours };
    const first = await captureHoursTick(storage, (work) => work(f.db), { now, bounds });
    const spent = (state: CaptureHoursAutoState, from: number) =>
      (state.sessions ?? []).filter((s) => s.at >= from).reduce((sum, s) => sum + s.ms, 0);
    assert.equal(first.sessions?.length, 2);
    assert.ok(spent(first, start) <= 30 + 3, `${spent(first, start)} ms in its first hour`);
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
    let commits = 0;
    const db: HistoryDatabase = {
      query: async (text, values) => {
        const result = await f.db.query(text, values);
        if (text === "COMMIT") commits++;
        return result;
      },
    };
    // The three hours before the settle horizon, as the database computes it.
    const end = (
      await f.db.query("SELECT date_trunc('hour',now() - interval '2 hours','UTC') AS at")
    ).rows[0]!.at as Date;
    const newest = [1, 2, 3].map((n) =>
      new Date(end.getTime() - n * 3_600_000).toISOString().replace(".000Z", "Z"),
    );
    const state = await captureHoursTick(memoryStorage(), (work) => work(db), {
      stopped: () => commits >= 3,
      bounds: { lookbackHours },
    });
    assert.equal(state.lastStop, "handover");
    // The newest hours come first, so the overview's usual windows are proven first.
    assert.deepEqual(Object.keys(await c.stored()), [...newest].reverse());
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
    // Newest first: the pool's first count is the hour before the settle horizon.
    const slowHour = (await planCaptureHours(f.db, lookbackHours))!.pools.find(
      (item) => item.pool === c.poolId,
    )!.hours[0]!;
    const cost = { ms: 5_000 };
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const storage = memoryStorage();
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
      // A stuck or paused tick leaves the overview readable, the hours it never counted unproven.
      const summary = await poolUsageSummary(
        f.db,
        { pool, from: at(-24 * 30), to: at(24), by: "model", authority: c.authority },
        async () => ({ prices: summaryPrices, issues: [] }),
        Date.parse(at(24)),
      );
      assert.equal(summary.homeCapture.status, "unavailable");
      assert.equal(summary.partial, true);
      const read = await c.coverage(at(0), at(24));
      assert.equal([...read.incomplete!].length, 24, "every hour of the day is unproven");
      assert.equal(read.ranges, undefined);
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

test("a failing count is an error stop that pauses the tick; a tick failing before any pool is stuck naming none", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const storage = memoryStorage();
    const failing = await captureHoursTick(
      storage,
      (work) => work(timed(f.db, clock, undefined, c.poolId)),
      { now: () => clock.at, bounds: { lookbackHours } },
    );
    assert.equal(failing.lastStop, "error");
    assert.deepEqual(failing.repeat, { pool: c.poolId, reason: "error", count: 1 });
    assert.equal(failing.pausedUntil, new Date(clock.at + 3_600_000).toISOString());
    let state = failing;
    for (let n = 0; n < 6; n++) {
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

test("once nothing is pending, each tick recounts the settled hours counted longest ago", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    await c.native(at(0, minute));
    await c.ready();
    await c.fill();
    // Thirty hours counted long ago, though each once it settled: three hours after it began.
    await f.db.query(
      `UPDATE basalt_model_capture_hours SET checked_at=hour + interval '3 hours'
      WHERE hour >= $1 AND hour < $2`,
      [at(0), at(30)],
    );
    const before = await f.db.query(
      "SELECT hour,checked_at FROM basalt_model_capture_hours WHERE hour >= $2 AND hour < $1 ORDER BY hour",
      [at(30), at(0)],
    );
    const state = await captureHoursTick(c.storage, (work) => work(f.db), {
      bounds: { lookbackHours },
    });
    assert.equal(state.lastStop, "complete");
    assert.equal(state.stalestCheckedAt, at(3));
    const after = await f.db.query(
      "SELECT hour,checked_at FROM basalt_model_capture_hours WHERE hour >= $2 AND hour < $1 ORDER BY hour",
      [at(30), at(0)],
    );
    const moved = after.rows.map(
      (row, n) =>
        (row.checked_at as Date).getTime() !== (before.rows[n]!.checked_at as Date).getTime(),
    );
    assert.deepEqual(
      moved,
      Array.from({ length: 30 }, (_, n) => n < 24),
      "the 24 counted longest ago, and only those",
    );
    const next = await captureHoursTick(c.storage, (work) => work(f.db), {
      bounds: { lookbackHours },
    });
    assert.equal(next.stalestCheckedAt, at(27));
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
