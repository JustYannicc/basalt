import assert from "node:assert/strict";
import { test } from "node:test";
import { CodeHandover } from "../../src/pool/code-handover.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import {
  usageRollupAutoKey,
  usageRollupStuckPools,
  usageRollupTick,
  type UsageRollupAutoState,
} from "../../src/pool/model-history/usage-rollup-auto.ts";
import {
  usageRollupHoldLimitMs,
  type runUsageRollup,
} from "../../src/pool/model-history/usage-rollup-backfill.ts";
import { seriesFixture } from "./series-fixture.ts";

/** The raw answer the rollup must reproduce exactly. */
const raw = `SELECT pool,date_trunc('hour',timestamp) AS hour,source,provider,model,
    count(*)::text AS requests,sum(input_tokens)::text AS input
  FROM basalt_model_requests GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;
const rolled = `SELECT pool,hour,source,provider,model,
    sum(requests)::text AS requests,sum(input_tokens_sum)::text AS input
  FROM basalt_model_usage_hourly GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;
const second = "0123456789abcdef";
const hour = 3_600_000;

const rows = (hours: number, perHour: number, pool?: string) =>
  Array.from({ length: hours * perHour }, (_, i) => ({
    ...(pool ? { pool } : {}),
    timestamp: timestamp(
      new Date(
        Date.parse("2026-01-01T00:00:00Z") + Math.floor(i / perHour) * hour + (i % perHour) * 1_000,
      ).toISOString(),
    ),
    provider: "fixture-lab",
    model: `fixture-model-${i % 3}`,
    inputTokens: String(1_000 + i),
    outputTokens: "10",
    totalTokens: String(1_010 + i),
    tokenQuality: "complete" as const,
  }));

/** History written before the rollup's trigger existed, as production's is. */
async function preexisting(
  f: { db: HistoryDatabase; insert: (...rows: object[]) => Promise<unknown> },
  ...batches: object[][]
) {
  await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
  for (const batch of batches) await f.insert(...batch);
  await f.db.query(
    "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_rollup",
  );
}

const memoryStorage = () => {
  const stored = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
    state: () => stored.get(usageRollupAutoKey) as UsageRollupAutoState | undefined,
  };
};
const ready = async (db: HistoryDatabase, pool: string) =>
  (await db.query("SELECT 1 FROM basalt_model_usage_ready WHERE pool=$1", [pool])).rows.length ===
  1;
const marked = async (db: HistoryDatabase, pool: string) =>
  Number(
    (
      await db.query("SELECT count(*)::int AS n FROM basalt_model_usage_hours WHERE pool=$1", [
        pool,
      ])
    ).rows[0]!.n,
  );

test("a pool with pending hours becomes ready by ticks alone", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(6, 3));
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    // Each clock read moves a millisecond, so a 3 ms session does an hour or two: several ticks.
    let ticks = 0;
    for (; ticks < 100 && !(await ready(f.db, pool)); ticks++) {
      await usageRollupTick(storage, (work) => work(f.db), {
        now: () => (clock += 1),
        bounds: { sessionMs: 3 },
      });
      clock += 300_000;
    }
    assert.ok(ticks > 2, `it took ${ticks} ticks`);
    assert.ok(await ready(f.db, pool), "ready by ticks alone");
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
    const after = await usageRollupTick(storage, (work) => work(f.db), { now: () => clock });
    assert.equal(after.lastStop, "ready", "a ready pool leaves nothing to do");
  });
});

test("one pool at a time: the second pool starts only on a later tick", async () => {
  await seriesFixture(async (f) => {
    const first = String((await f.row()).pool);
    await preexisting(f, rows(3, 2), rows(3, 2, second));
    const storage = memoryStorage();
    const [a, b] = [first, second].sort();
    const tick = await usageRollupTick(storage, (work) => work(f.db), {
      now: () => Date.parse("2026-02-01T00:00:00Z"),
    });
    assert.equal(tick.lastStop, "complete");
    assert.ok(await ready(f.db, a!), "the first pool finished in this tick");
    assert.equal(await marked(f.db, b!), 0, "the second pool was not started in the same tick");
    await usageRollupTick(storage, (work) => work(f.db), {
      now: () => Date.parse("2026-02-01T00:05:00Z"),
    });
    assert.ok(await ready(f.db, b!), "the next tick takes the second pool");
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("the hourly ceilings hold over any sliding hour, across ticks", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(48, 2));
    const start = Date.parse("2026-02-01T00:00:00Z");
    for (const ceiling of [{ hourMs: 3 }, { hourWalBytes: 1 }]) {
      await f.db.query("DELETE FROM basalt_model_usage_hours");
      const storage = memoryStorage();
      let clock = start;
      // Each clock read moves a millisecond, and every session writes WAL, so one session fills it.
      const now = () => (clock += 1);
      const bounds = { ...ceiling, sessionMs: 3 };
      const first = await usageRollupTick(storage, (work) => work(f.db), { now, bounds });
      assert.equal(
        first.lastStop,
        "ceiling",
        `the second session stops at ${Object.keys(ceiling)}`,
      );
      const done = await marked(f.db, pool);
      assert.ok(done > 0, "the first session ran");
      // 59 minutes after that session it is still inside the hour, even across a clock hour.
      clock = start + 59 * 60_000;
      const next = await usageRollupTick(storage, (work) => work(f.db), { now, bounds });
      assert.equal(next.lastStop, "ceiling");
      assert.equal(await marked(f.db, pool), done, "nothing more within 60 minutes of it");
      clock = start + hour + 1_000;
      await usageRollupTick(storage, (work) => work(f.db), { now, bounds });
      assert.ok((await marked(f.db, pool)) > done, "an hour after it, it runs again");
    }
  });
});

test("each session's time and WAL budgets are capped by what the hour has left", async () => {
  // A recording runner: the budgets the tick hands to the backfill, and nothing else.
  const calls: { budgetMs: number; walBytes: number }[] = [];
  const run: typeof runUsageRollup = async (_db, _plan, budgetMs, _now, walBytes) => {
    calls.push({ budgetMs: budgetMs!, walBytes: walBytes! });
    return {
      status: "progress",
      stopped: "budget",
      maxHoldMs: 10,
      walBytes: 1_000,
      pools: [{ pool: second, recomputedHours: 1, groups: 1, remainingHours: 5 }],
    };
  };
  const plan = async () => ({
    plan: { pools: [{ pool: second, from: "", to: "", days: 1 }] },
    digest: "",
    ready: [],
    recomputedHours: {},
  });
  const storage = memoryStorage();
  let clock = Date.parse("2026-02-01T00:00:00Z");
  const now = () => clock;
  const db: HistoryDatabase = { query: async () => ({ rows: [], rowCount: 0 }) };
  // Sessions in the last hour used 290 s and 200 MiB of the 300 s and 256 MiB.
  await storage.put(usageRollupAutoKey, {
    sessions: [{ at: clock - 10 * 60_000, ms: 290_000, walBytes: 200 * 1024 * 1024 }],
  });
  await usageRollupTick(storage, (work) => work(db), { now, plan, run, bounds: { sessions: 1 } });
  assert.deepEqual(calls.pop(), { budgetMs: 10_000, walBytes: 16 * 1024 * 1024 });
  await storage.put(usageRollupAutoKey, {
    sessions: [{ at: clock - 10 * 60_000, ms: 0, walBytes: 250 * 1024 * 1024 }],
  });
  clock += 1;
  await usageRollupTick(storage, (work) => work(db), { now, plan, run, bounds: { sessions: 1 } });
  assert.deepEqual(calls.pop(), { budgetMs: 12_000, walBytes: 6 * 1024 * 1024 });
  await storage.put(usageRollupAutoKey, {});
  clock += 1;
  await usageRollupTick(storage, (work) => work(db), { now, plan, run, bounds: { sessions: 1 } });
  assert.deepEqual(
    calls.pop(),
    { budgetMs: 12_000, walBytes: 16 * 1024 * 1024 },
    "16 MiB a session",
  );
});

test("a slow stop pauses for an hour and resumes by itself; a slow hour three times is stuck", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(6, 3));
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    const tick = (bounds = {}) =>
      usageRollupTick(storage, (work) => work(f.db), { now: () => clock, bounds });
    // A 1 ms hour limit makes every attempt slow.
    const slow = await tick({ hourLimitMs: 1 });
    assert.equal(slow.lastStop, "slow_hour");
    assert.ok(slow.pausedUntil);
    clock += 300_000;
    const paused = await tick();
    assert.equal(paused.lastTickAt, slow.lastTickAt, "a paused tick does nothing");
    assert.equal(await marked(f.db, pool), 0);
    clock += hour;
    await tick({ hourLimitMs: 1 });
    clock += hour + 60_000;
    const third = await tick({ hourLimitMs: 1 });
    assert.deepEqual(usageRollupStuckPools(third), [pool]);
    assert.equal(third.stuck?.[0]?.hour, slow.lastHour);
    clock += hour + 60_000;
    const skipped = await tick();
    assert.equal(
      skipped.lastStop,
      "ready",
      "a stuck pool is skipped, not retried, until its retry",
    );
    assert.equal(await marked(f.db, pool), 0);
    // A day later it is tried again, and with a normal limit it finishes and clears itself.
    clock += 24 * hour;
    for (let i = 0; i < 20 && !(await ready(f.db, pool)); i++) {
      await tick();
      clock += 300_000;
    }
    assert.ok(await ready(f.db, pool));
    assert.deepEqual(
      usageRollupStuckPools(storage.state()!),
      [],
      "a ready pool is no longer stuck",
    );
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("a hold past its limit three times on the same hour is stuck too, and other pools go on", async () => {
  await seriesFixture(async (f) => {
    const first = String((await f.row()).pool);
    await preexisting(f, rows(3, 2), rows(3, 2, second));
    const [a, b] = [first, second].sort();
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    // A cancelled recompute (1 ms limit) that appears to hold the pool past the limit: the hour is
    // never done, so the same hour comes back each time.
    const slowly: HistoryDatabase = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("pg_try_advisory_xact_lock")) clock += usageRollupHoldLimitMs + 50;
        return f.db.query(text, values);
      },
    };
    for (let i = 0; i < 3; i++) {
      const held = await usageRollupTick(storage, (work) => work(slowly), {
        now: () => clock,
        bounds: { hourLimitMs: 1 },
      });
      assert.equal(held.lastStop, "slow_hold");
      clock += hour + 60_000;
    }
    assert.deepEqual(usageRollupStuckPools(storage.state()!), [a]);
    // The stuck pool is skipped; the next pool is backfilled by the following ticks.
    for (let i = 0; i < 10 && !(await ready(f.db, b!)); i++) {
      await usageRollupTick(storage, (work) => work(f.db), { now: () => clock });
      clock += 300_000;
    }
    assert.ok(await ready(f.db, b!), "the other pool is not held up");
    assert.ok(!(await ready(f.db, a!)));
  });
});

test("a stuck pool clears itself once its hour is done another way", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(6, 3));
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    for (let i = 0; i < 3; i++) {
      await usageRollupTick(storage, (work) => work(f.db), {
        now: () => clock,
        bounds: { hourLimitMs: 1 },
      });
      clock += hour + 60_000;
    }
    const stuck = storage.state()!.stuck![0]!;
    // An operator recomputes the stuck hour by hand.
    await f.db.query(
      "SELECT basalt_model_usage_recompute($1,$2::timestamptz,$2::timestamptz + interval '1 hour')",
      [pool, stuck.hour],
    );
    const next = await usageRollupTick(storage, (work) => work(f.db), { now: () => clock });
    assert.deepEqual(usageRollupStuckPools(next), [], "cleared without a person resetting it");
    assert.ok((await marked(f.db, pool)) > 1, "and the pool goes on");
  });
});

test("an error pauses for an hour, and six errors in a row on a pool are stuck", async (t) => {
  t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(6, 3));
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    const failing = {
      now: () => clock,
      run: (async () => {
        throw new Error("permission denied");
      }) as unknown as typeof runUsageRollup,
    };
    const first = await usageRollupTick(storage, (work) => work(f.db), failing);
    assert.equal(first.lastStop, "error");
    assert.ok(first.pausedUntil, "an error pauses");
    clock += 300_000;
    const paused = await usageRollupTick(storage, (work) => work(f.db), failing);
    assert.equal(paused.lastTickAt, first.lastTickAt, "and the next tick waits");
    for (let i = 1; i < 6; i++) {
      clock += hour + 60_000;
      await usageRollupTick(storage, (work) => work(f.db), failing);
    }
    assert.deepEqual(usageRollupStuckPools(storage.state()!), [pool]);
    assert.equal(storage.state()!.stuck![0]!.reason, "error");
  });
});

test("a handover that starts mid-tick never waits for the tick, and no hour is half-counted", async (t) => {
  t.mock.method(console, "info", () => {});
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(24, 3));
    const storage = memoryStorage();
    let tick: Promise<unknown> | undefined;
    const aborted: string[] = [];
    const own = { candidate: "a".repeat(40), workerInput: "1".repeat(64) };
    const handoverStorage = new Map<string, unknown>();
    const handover = new CodeHandover({
      own,
      storage: {
        get: async (key) => handoverStorage.get(key),
        put: async (key, value) => void handoverStorage.set(key, value),
      },
      inFlight: () => 0,
      // The Home pass that holds the tick counts as busy, as in the pool's object.
      busy: () => tick !== undefined,
      abort: (reason) => void aborted.push(reason),
      defer: (work) => void work,
      wait: (milliseconds) => new Promise((done) => setTimeout(done, Math.min(milliseconds, 20))),
    });
    let commits = 0;
    let handoverAt = 0;
    const db: HistoryDatabase = {
      query: async (text: string, values?: unknown[]) => {
        const result = await f.db.query(text, values);
        // The deployed code's adoption read arrives just after the second hour committed.
        if (text === "COMMIT" && ++commits === 2) {
          handoverAt = performance.now();
          handover.offer({ candidate: "b".repeat(40), workerInput: "2".repeat(64) });
        }
        return result;
      },
    };
    tick = usageRollupTick(storage, (work) => work(db), {
      stopped: () => handover.draining,
    }).finally(() => {
      tick = undefined;
    });
    const state = (await tick) as UsageRollupAutoState;
    const tickEnded = performance.now();
    for (let i = 0; i < 100 && !aborted.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(aborted, ["code handover"], "the handover finished and reset the object");
    assert.equal(state.lastStop, "handover");
    assert.ok(tickEnded - handoverAt < 2_000, "the tick ended within the hour in flight");
    const done = await marked(f.db, pool);
    assert.ok(done >= 2 && done <= 3, `only whole hours: ${done}`);
    // Every hour the rollup holds is a marked hour, recomputed in full; nothing else is there.
    const hours = (
      await f.db.query(
        `SELECT count(*)::int AS n FROM (SELECT DISTINCT hour FROM basalt_model_usage_hourly) h
        WHERE NOT EXISTS (SELECT 1 FROM basalt_model_usage_hours m WHERE m.pool=$1 AND m.hour=h.hour)`,
        [pool],
      )
    ).rows[0]!.n;
    assert.equal(hours, 0, "no hour is half-counted");
    // The next tick, on the new code, recomputes the rest.
    for (let i = 0; i < 20 && !(await ready(f.db, pool)); i++)
      await usageRollupTick(storage, (work) => work(f.db));
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("a session killed mid-tick, as by a reset, loses and double-counts nothing", async (t) => {
  t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(12, 3));
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    let commits = 0;
    // The third hour's commit never arrives: the session dies with that hour in flight.
    const killed: HistoryDatabase = {
      query: async (text: string, values?: unknown[]) => {
        if (text === "COMMIT" && ++commits === 3) throw new Error("connection terminated");
        return f.db.query(text, values);
      },
    };
    const failed = await usageRollupTick(storage, (work) => work(killed), { now: () => clock });
    assert.equal(failed.lastStop, "error");
    await f.db.query("ROLLBACK").catch(() => {});
    assert.equal(await marked(f.db, pool), 2, "only the committed hours are marked");
    for (let i = 0; i < 20 && !(await ready(f.db, pool)); i++) {
      clock += hour + 60_000;
      await usageRollupTick(storage, (work) => work(f.db), { now: () => clock });
    }
    assert.ok(await ready(f.db, pool));
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});
