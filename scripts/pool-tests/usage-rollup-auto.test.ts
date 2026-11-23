import assert from "node:assert/strict";
import { test } from "node:test";
import { timestamp } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import {
  usageRollupAutoKey,
  usageRollupTick,
  type UsageRollupAutoState,
} from "../../src/pool/model-history/usage-rollup-auto.ts";
import { seriesFixture } from "./series-fixture.ts";

/** The raw answer the rollup must reproduce exactly. */
const raw = `SELECT pool,date_trunc('hour',timestamp) AS hour,source,provider,model,
    count(*)::text AS requests,sum(input_tokens)::text AS input
  FROM basalt_model_requests GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;
const rolled = `SELECT pool,hour,source,provider,model,
    sum(requests)::text AS requests,sum(input_tokens_sum)::text AS input
  FROM basalt_model_usage_hourly GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;
const second = "0123456789abcdef";

const rows = (hours: number, perHour: number, pool?: string) =>
  Array.from({ length: hours * perHour }, (_, i) => ({
    ...(pool ? { pool } : {}),
    timestamp: timestamp(
      new Date(
        Date.parse("2026-01-01T00:00:00Z") +
          Math.floor(i / perHour) * 3_600_000 +
          (i % perHour) * 1_000,
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

test("the hourly ceilings stop ticks for the rest of the hour", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(48, 2));
    const start = Date.parse("2026-02-01T00:00:00Z");
    for (const ceiling of [{ hourMs: 3 }, { hourWalBytes: 1 }]) {
      await f.db.query("DELETE FROM basalt_model_usage_hours");
      const storage = memoryStorage();
      let clock = start;
      // Each session appears to take a millisecond, and writes WAL, so one session fills the hour.
      const now = () => (clock += 1);
      const first = await usageRollupTick(storage, (work) => work(f.db), {
        now,
        bounds: { ...ceiling, sessionMs: 3 },
      });
      assert.equal(
        first.lastStop,
        "ceiling",
        `the second session stops at ${Object.keys(ceiling)}`,
      );
      const done = await marked(f.db, pool);
      assert.ok(done > 0, "the first session ran");
      clock = start + 300_000;
      const next = await usageRollupTick(storage, (work) => work(f.db), {
        now,
        bounds: { ...ceiling, sessionMs: 3 },
      });
      assert.equal(next.lastStop, "ceiling");
      assert.equal(await marked(f.db, pool), done, "nothing more within the same hour");
      clock = start + 3_600_000;
      await usageRollupTick(storage, (work) => work(f.db), {
        now,
        bounds: { ...ceiling, sessionMs: 3 },
      });
      assert.ok((await marked(f.db, pool)) > done, "the next hour runs again");
    }
  });
});

test("a slow stop pauses for an hour, then resumes by itself; a repeatedly slow hour is stuck", async () => {
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
    clock += 3_600_000;
    await tick({ hourLimitMs: 1 });
    clock += 3_700_000;
    const third = await tick({ hourLimitMs: 1 });
    assert.deepEqual(third.stuck, { pool, hour: slow.lastHour });
    clock += 3_700_000;
    const stuck = await tick();
    assert.equal(stuck.lastTickAt, third.lastTickAt, "a stuck rollup waits for a person");
    // Without the 1 ms limit and with the stuck mark cleared, it resumes and finishes.
    await storage.put(usageRollupAutoKey, {});
    for (let i = 0; i < 20 && !(await ready(f.db, pool)); i++) {
      clock += 300_000;
      await tick();
    }
    assert.ok(await ready(f.db, pool));
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("a session killed mid-tick, as by a release, loses and double-counts nothing", async (t) => {
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
      clock += 3_700_000;
      await usageRollupTick(storage, (work) => work(f.db), { now: () => clock });
    }
    assert.ok(await ready(f.db, pool));
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});
