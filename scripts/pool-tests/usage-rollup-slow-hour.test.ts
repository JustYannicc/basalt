import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { timestamp } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import {
  usageRollupAutoKey,
  usageRollupStuckPools,
  usageRollupTick,
  type UsageRollupAutoState,
} from "../../src/pool/model-history/usage-rollup-auto.ts";
import {
  planUsageRollup,
  runUsageRollup,
  usageRollupHourLimitMs,
} from "../../src/pool/model-history/usage-rollup-backfill.ts";
import { usageRollupInspect } from "../../src/pool/model-history/usage-rollup-inspect.ts";
import {
  prewarmUsageRollupHour,
  usageRollupAttemptMarginMs,
  usageRollupMinReadMs,
  usageRollupReadLimitMs,
} from "../../src/pool/model-history/usage-rollup-hour.ts";
import { usageRollupLockClass } from "../../src/pool/model-history/usage-rollup-schema.ts";
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
const minute = 60_000;
/** The first hour holding rows; the slow one in these tests. */
const dense = "2026-01-01T00:00:00.000Z";

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

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];

/** History written before the rollup's trigger existed, as production's is. */
async function preexisting(f: Fixture, ...batches: object[][]) {
  await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
  for (const batch of batches) await f.insert(...batch);
  await f.db.query(
    "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_rollup",
  );
}

/**
 * Test-only: the recompute of one pool's hour sleeps past the hour limit on its first row, for the
 * first `attempts` attempts. A sequence is not rolled back by the cancel, so it counts attempts.
 */
async function slowHour(
  db: HistoryDatabase,
  pool: string,
  at: string | readonly string[],
  attempts: number,
) {
  const hours = (typeof at === "string" ? [at] : at).map((hour) => `'${hour}'`).join(",");
  await db.query("CREATE SEQUENCE slow_hour_fixture_attempts");
  await db.query(`CREATE FUNCTION slow_hour_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.pool = '${pool}' AND NEW.hour = ANY(ARRAY[${hours}]::timestamptz[])
        AND nextval('slow_hour_fixture_attempts') <= ${attempts} THEN
        PERFORM pg_sleep(0.3);
      END IF;
      RETURN NEW;
    END $$`);
  await db.query(`CREATE TRIGGER slow_hour_fixture BEFORE INSERT ON basalt_model_usage_hourly
    FOR EACH ROW EXECUTE FUNCTION slow_hour_fixture()`);
  return () => db.query("DROP TRIGGER slow_hour_fixture ON basalt_model_usage_hourly");
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
/** Marks the empty day before a pool's first rows done, so the dense hour is its first pending. */
const firstPending = (db: HistoryDatabase, pool: string) =>
  db.query("SELECT basalt_model_usage_recompute($1,$2::timestamptz,$3::timestamptz)", [
    pool,
    "2025-12-31T00:00:00Z",
    dense,
  ]);

test("a dense first hour stalls only its own pool: the rest of it and other pools go on, it stays loud, and it finishes once it fits", async (t) => {
  const stuckLog = t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const [a, b] = [String((await f.row()).pool), second].sort() as [string, string];
    await preexisting(f, rows(6, 3, a), rows(3, 2, b));
    await firstPending(f.db, a);
    const fits = await slowHour(f.db, a, dense, 1_000_000);
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    const tick = () => usageRollupTick(storage, (work) => work(f.db), { now: () => clock });
    const first = await tick();
    // Without a slow hour the second pool starts only on the next tick; it is not delayed.
    assert.ok(await ready(f.db, b), "the other pool finished in the same tick");
    // Its 48 planned hours: the day before its rows was done already, and only the dense one is left.
    assert.equal(await marked(f.db, a), 47, "every light hour committed");
    assert.ok(!(await ready(f.db, a)));
    assert.equal(first.pausedUntil, undefined, "nothing pauses the tick");
    assert.deepEqual(first.slow, [
      {
        pool: a,
        hour: dense,
        count: 1,
        until: new Date(clock + 10 * minute).toISOString(),
        hours: [dense],
      },
    ]);
    clock += 5 * minute;
    const waiting = await tick();
    assert.equal(waiting.lastStop, "waiting", "the pool waits out its slow wait");
    clock += 5 * minute + 1_000;
    assert.equal((await tick()).slow?.[0]?.count, 2);
    clock += 10 * minute + 1_000;
    await tick();
    const stuck = storage.state()!;
    assert.deepEqual(usageRollupStuckPools(stuck), [a], "the monitor's stuck event fires");
    assert.deepEqual(stuck.stuck, [
      {
        pool: a,
        reason: "slow",
        hour: dense,
        retryAt: new Date(clock + 10 * minute).toISOString(),
      },
    ]);
    assert.ok(
      stuckLog.mock.calls.some(
        (call) =>
          call.arguments[0] === "POOL_USAGE_ROLLUP_STUCK" &&
          JSON.stringify(call.arguments[1]) === JSON.stringify({ reason: "slow", hour: dense }),
      ),
      "loud, naming the hour",
    );
    assert.equal(stuck.lastHour, dense);
    assert.equal(stuck.lastHourPhase, "recompute");
    // Still stuck, it is retried after every slow wait, not once a day.
    clock += 10 * minute + 1_000;
    const retried = await tick();
    assert.equal(retried.slow?.[0]?.count, 4, "the retry ran");
    assert.deepEqual(usageRollupStuckPools(retried), [a]);
    assert.equal(
      stuckLog.mock.calls.filter((call) => call.arguments[0] === "POOL_USAGE_ROLLUP_STUCK").length,
      1,
      "loud once when it became stuck, not at every retry",
    );
    // The hour fits now: the next pass after the wait finishes the pool and clears it.
    await fits();
    clock += 10 * minute + 1_000;
    const done = await tick();
    assert.ok(await ready(f.db, a), "ready by ticks alone");
    assert.deepEqual(usageRollupStuckPools(done), []);
    assert.deepEqual(done.slow, []);
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("an hour slow only while cold is set aside, retried after the pool's other hours, and the pool completes in the same call", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(6, 3));
    await slowHour(f.db, pool, dense, 3);
    const { plan } = await planUsageRollup(f.db);
    // Every statement in order, and whether the transaction held an advisory lock after each read.
    const log: { kind: "read" | "lock"; at: string; locks?: number }[] = [];
    const db: HistoryDatabase = {
      query: async (text: string, values?: unknown[]) => {
        const result = await f.db.query(text, values);
        if (text.includes("hour_limit")) {
          const held = await f.db.query(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()",
          );
          log.push({ kind: "read", at: String(values![1]), locks: Number(held.rows[0]!.n) });
        }
        return result;
      },
    };
    const traced: HistoryDatabase = {
      query: (text: string, values?: unknown[]) => {
        if (text.includes("pg_try_advisory_xact_lock"))
          log.push({ kind: "lock", at: String(values![1]) });
        return db.query(text, values);
      },
    };
    const result = await runUsageRollup(traced, plan, 60_000);
    assert.equal(result.status, "complete", JSON.stringify(result));
    const locks = log.filter((entry) => entry.kind === "lock").map((entry) => entry.at);
    const pending = plan.pools[0]!.days * 24;
    assert.equal(locks.length, pending + 3, "three slow attempts, then one that fits");
    const tries = locks.flatMap((at, index) => (at === dense ? [index] : []));
    const others = locks.flatMap((at, index) => (at === dense ? [] : [index]));
    assert.equal(tries.length, 4);
    assert.ok(tries[3]! > Math.max(...others), "its last try comes after every other hour");
    assert.ok(tries[2]! < Math.min(...others.filter((index) => locks[index]! > dense)));
    // Every attempt warmed its hour first, holding no advisory lock while it read.
    for (const [index, entry] of log.entries())
      if (entry.kind === "lock")
        assert.deepEqual(log[index - 1], { kind: "read", at: entry.at, locks: 0 });
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("where a slow hour was cancelled, and how long its read ran, reach the state and the inspect", async (t) => {
  t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(6, 3));
    await firstPending(f.db, pool);
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    // A 1 ms read limit cancels every warming read: the slow hour's phase is the read.
    const read = await usageRollupTick(storage, (work) => work(f.db), {
      now: () => clock,
      bounds: { readLimitMs: 1 },
    });
    assert.equal(read.lastHourPhase, "read");
    assert.equal(read.lastHourReadMs, 1, "a cancelled read counts its whole limit");
    assert.equal(await marked(f.db, pool), 24, "no hour got past its read");
    assert.deepEqual(
      [usageRollupInspect(read).lastHour, usageRollupInspect(read).lastHourPhase],
      [dense, "read"],
    );
    assert.equal(usageRollupInspect(read).lastHourReadMs, 1);
    // The read fits and the recompute does not: the phase is the recompute, with the read's time.
    await slowHour(f.db, pool, dense, 1_000_000);
    clock += 10 * minute + 1_000;
    const recompute = await usageRollupTick(storage, (work) => work(f.db), { now: () => clock });
    assert.equal(recompute.lastHour, dense);
    assert.equal(recompute.lastHourPhase, "recompute");
    const readMs = recompute.lastHourReadMs!;
    assert.ok(readMs > 0 && readMs < 2_000, `the read took ${readMs} ms`);
    assert.equal(Math.round(readMs * 10) / 10, readMs, "rounded to a tenth of a millisecond");
    const inspected = usageRollupInspect(recompute);
    assert.equal(inspected.lastHour, dense);
    assert.equal(inspected.lastHourPhase, "recompute");
    assert.equal(inspected.lastHourReadMs, readMs);
    assert.equal(inspected.totalPendingHours, 1, "only the slow hour is left");
  });
});

test("the warming read takes no advisory lock: beside a writer holding the pool it completes and the call steps aside", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(2, 3));
    const plan = { pools: [{ pool, from: dense, to: "2026-01-01T01:00:00.000Z", days: 0 }] };
    const writer = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await writer.connect();
    try {
      await writer.query(`SET search_path TO ${f.schema}`);
      // As a writer inside the hour holds it: the pool's shared lock, in an open transaction.
      await writer.query("BEGIN");
      await writer.query("SELECT pg_advisory_xact_lock_shared($1,hashtext($2))", [
        usageRollupLockClass,
        pool,
      ]);
      let reads = 0;
      const db: HistoryDatabase = {
        query: async (text: string, values?: unknown[]) => {
          const result = await f.db.query(text, values);
          if (text.includes("hour_limit") && result.rows.length === 1) reads++;
          return result;
        },
      };
      const started = performance.now();
      const result = await runUsageRollup(db, plan, 60_000);
      const took = performance.now() - started;
      assert.equal(result.stopped, "lock", "it never waits for the writer");
      assert.ok(reads >= 1, "the read finished beside the writer");
      // Five refusals 50 ms apart; a read that queued for the lock would wait out its 2 s limit.
      assert.ok(took < 1_500, `the call took ${Math.round(took)} ms`);
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK").catch(() => {});
      await writer.end();
    }
  });
});

test("the warming read aggregates exactly the rows the recompute writes, at both edges of the hour", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    // Rows at both edges of 05:00, including exact times the indexed time rounds across them.
    const edges = [
      "2026-01-01T04:59:59.500000000Z",
      "2026-01-01T04:59:59.999999600Z",
      "2026-01-01T05:00:00.000000000Z",
      "2026-01-01T05:30:00.000000000Z",
      "2026-01-01T05:59:59.999999000Z",
      "2026-01-01T05:59:59.999999600Z",
      "2026-01-01T06:00:00.000000000Z",
      "2026-01-01T06:00:00.500000000Z",
    ];
    await preexisting(
      f,
      edges.map((at, i) => ({
        timestamp: timestamp(at),
        provider: "fixture-lab",
        model: `fixture-model-${i % 3}`,
        inputTokens: "100",
        outputTokens: "10",
        totalTokens: "110",
        tokenQuality: "complete" as const,
      })),
    );
    for (const [at, requests] of [
      ["2026-01-01T04:00:00.000Z", "2"],
      ["2026-01-01T05:00:00.000Z", "4"],
      ["2026-01-01T06:00:00.000Z", "2"],
    ] as const) {
      const warmed = await prewarmUsageRollupHour(f.db, pool, at);
      await f.db.query(
        "SELECT basalt_model_usage_recompute($1,$2::timestamptz,$2::timestamptz + interval '1 hour')",
        [pool, at],
      );
      const written = (
        await f.db.query(
          `SELECT count(*)::int AS groups, coalesce(sum(requests),0)::text AS requests
          FROM basalt_model_usage_hourly WHERE pool=$1 AND hour=$2::timestamptz`,
          [pool, at],
        )
      ).rows[0]!;
      assert.deepEqual(
        { groups: warmed.groups, requests: warmed.requests },
        { groups: Number(written.groups), requests: String(written.requests) },
        at,
      );
      assert.equal(warmed.requests, requests, `the rows whose exact time is in ${at}`);
    }
  });
});

test("the total of pending hours covers every pool not ready, and only those", async () => {
  await seriesFixture(async (f) => {
    const [a, b] = [String((await f.row()).pool), second].sort() as [string, string];
    await preexisting(f, rows(6, 3, a), rows(30, 2, b));
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    const left = async () => {
      const { plan } = await planUsageRollup(f.db);
      let total = 0;
      for (const item of plan.pools)
        total += Number(
          (
            await f.db.query(
              `SELECT count(*)::int AS n FROM generate_series($2::timestamptz,
                $3::timestamptz - interval '1 hour', interval '1 hour') AS h(at)
              WHERE NOT EXISTS (SELECT 1 FROM basalt_model_usage_hours d
                WHERE d.pool=$1 AND d.hour=h.at)`,
              [item.pool, item.from, item.to],
            )
          ).rows[0]!.n,
        );
      return total;
    };
    // Each clock read moves a millisecond, so a 3 ms session does an hour or two.
    const now = () => (clock += 1);
    const partial = await usageRollupTick(storage, (work) => work(f.db), {
      now,
      bounds: { sessionMs: 3 },
    });
    assert.ok((await marked(f.db, a)) > 0 && !(await ready(f.db, a)), "the first pool is partway");
    assert.equal(partial.totalPendingHours, await left());
    assert.ok(partial.totalPendingHours! > partial.pendingHours!, "both pools counted");
    for (let i = 0; i < 200 && !(await ready(f.db, a)); i++) {
      clock += 5 * minute;
      await usageRollupTick(storage, (work) => work(f.db), { now, bounds: { sessionMs: 3 } });
    }
    const after = storage.state()!;
    assert.equal(after.totalPendingHours, await left(), "a ready pool counts no longer");
    assert.equal(usageRollupInspect(after).totalPendingHours, after.totalPendingHours);
    // The total is a diagnostic: a read of it that fails keeps the last one and fails nothing.
    const failing: HistoryDatabase = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("p.since")) throw new Error("canceling statement due to user request");
        return f.db.query(text, values);
      },
    };
    clock += 5 * minute;
    const kept = await usageRollupTick(storage, (work) => work(failing), {
      now,
      bounds: { sessionMs: 3 },
    });
    assert.notEqual(kept.lastStop, "error");
    assert.equal(kept.pausedUntil, undefined);
    assert.equal(kept.totalPendingHours, after.totalPendingHours);
  });
});

/** One attempt's worst case: the longest read, the hour limit and the margin. */
const attemptWorstMs = usageRollupReadLimitMs + usageRollupHourLimitMs + usageRollupAttemptMarginMs;
/** The least budget an attempt other than a call's first starts with. */
const leastAttemptMs = usageRollupMinReadMs + usageRollupHourLimitMs + usageRollupAttemptMarginMs;

/**
 * The test's clock, as production spends it: a dense hour's warming read takes 1.9 s, as a cold one
 * does there, but never more than the limit it was given, past which it is cancelled; a cancelled
 * recompute takes its whole hour limit.
 */
function timed(db: HistoryDatabase, pool: string, dense: readonly string[], clock: { at: number }) {
  let limit = Number.POSITIVE_INFINITY;
  return {
    query: async (text: string, values?: unknown[]) => {
      if (text.includes("set_config('synchronous_commit'"))
        limit = Number.parseInt(String(values![0]));
      if (
        text.includes("hour_limit") &&
        values![0] === pool &&
        dense.includes(String(values![1]))
      ) {
        clock.at += Math.min(1_900, limit);
        if (limit < 1_900)
          throw Object.assign(new Error("canceling statement due to statement timeout"), {
            code: "57014",
          });
      }
      try {
        return await db.query(text, values);
      } catch (error) {
        if (text.includes("pg_try_advisory_xact_lock")) clock.at += usageRollupHourLimitMs;
        throw error;
      }
    },
  } satisfies HistoryDatabase;
}

test("dense hours at a pool's head never loop silently on its budget: its light hours commit, other pools go on, and it is loud until they fit", async (t) => {
  const stuckLog = t.mock.method(console, "error", () => {});
  const denseHours = [dense, "2026-01-01T01:00:00.000Z", "2026-01-01T02:00:00.000Z"];
  // Ticks until the other pool is ready, and the end state, with or without the dense hours.
  const scenario = async (withDense: boolean) => {
    let ticks = 0;
    let after: UsageRollupAutoState | undefined;
    await seriesFixture(async (f) => {
      const [a, b] = [String((await f.row()).pool), second].sort() as [string, string];
      await preexisting(f, rows(6, 3, a), rows(3, 2, b));
      await firstPending(f.db, a);
      const fits = withDense ? await slowHour(f.db, a, denseHours, 1_000_000) : async () => {};
      const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
      let heavy = withDense ? denseHours : [];
      const storage = memoryStorage();
      const tick = () =>
        usageRollupTick(storage, (work) => work(timed(f.db, a, heavy, clock)), {
          now: () => clock.at,
        });
      const first = await tick();
      ticks++;
      if (withDense) {
        const wait = first.slow?.find((entry) => entry.pool === a);
        assert.equal(wait?.count, 1, "a budget spent on dense hours alone is a slow stop");
        assert.equal(wait?.until, new Date(clock.at + 10 * minute).toISOString());
        assert.equal(first.pausedUntil, undefined);
      }
      for (; ticks < 12 && !(await ready(f.db, b)); ticks++) {
        clock.at += 10 * minute + 1_000;
        await tick();
      }
      if (!withDense) return;
      // While they stay dense, every light hour commits and the pool is stuck, loud, naming one.
      for (let i = 0; i < 12 && !usageRollupStuckPools(storage.state()!).includes(a); i++) {
        clock.at += 10 * minute + 1_000;
        await tick();
      }
      assert.equal(await marked(f.db, a), 48 - denseHours.length, "every light hour committed");
      const stuck = storage.state()!.stuck?.find((entry) => entry.pool === a);
      assert.equal(stuck?.reason, "slow");
      assert.ok(denseHours.includes(stuck!.hour!), `stuck on ${stuck?.hour}`);
      assert.ok(
        stuckLog.mock.calls.some((call) => call.arguments[0] === "POOL_USAGE_ROLLUP_STUCK"),
      );
      // Once they fit, ticks alone finish the pool and clear it.
      await fits();
      heavy = [];
      for (let i = 0; i < 6 && !(await ready(f.db, a)); i++) {
        clock.at += 10 * minute + 1_000;
        await tick();
      }
      assert.ok(await ready(f.db, a), "ready once its hours fit");
      after = storage.state();
      assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
    });
    return { ticks, after };
  };
  const without = await scenario(false);
  const dense3 = await scenario(true);
  assert.ok(
    dense3.ticks <= without.ticks,
    `the other pool took ${dense3.ticks} ticks, ${without.ticks} without the dense hours`,
  );
  assert.deepEqual(usageRollupStuckPools(dense3.after!), []);
  assert.deepEqual(dense3.after!.slow, []);
});

test("a call over slow warming reads ends within its budget and one attempt's worst case, and so does the hourly ceiling", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, rows(6, 3));
    const denseHours = Array.from({ length: 6 }, (_, i) =>
      new Date(Date.parse(dense) + i * hour).toISOString(),
    );
    await slowHour(f.db, pool, denseHours, 1_000_000);
    const plan = { pools: [{ pool, from: dense, to: "2026-01-01T06:00:00.000Z", days: 0 }] };
    // Budgets that end between attempts and between hours, and one smaller than any attempt: a
    // call ends within its budget, and only a budget below one attempt's least is passed, by at most
    // one attempt's worst case.
    for (const budgetMs of [4_110, 4_400, 6_200, 12_000, 100]) {
      const clock = { at: 0 };
      const result = await runUsageRollup(
        timed(f.db, pool, denseHours, clock),
        plan,
        budgetMs,
        () => clock.at,
      );
      assert.equal(result.stopped, "budget", JSON.stringify(result));
      const bound = budgetMs < leastAttemptMs ? budgetMs + attemptWorstMs : budgetMs;
      assert.ok(clock.at <= bound, `a ${budgetMs} ms call took ${clock.at} ms`);
      // A call whose only read the budget cut short learned nothing about the hour.
      if (budgetMs < leastAttemptMs) assert.equal(result.slowHours?.length ?? 0, 0);
      else assert.ok(result.slowHours?.length, `a ${budgetMs} ms call says which hours were slow`);
    }
    // The hourly ceiling: 299 s of the 300 s spent, so the session gets 1 s and one attempt over it.
    const storage = memoryStorage();
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    await storage.put(usageRollupAutoKey, {
      sessions: [{ at: clock.at - 10 * minute, ms: 299_000, walBytes: 0 }],
    });
    const state = await usageRollupTick(
      storage,
      (work) => work(timed(f.db, pool, denseHours, clock)),
      {
        now: () => clock.at,
        plan: async () => ({ plan, digest: "", ready: [], recomputedHours: {} }),
      },
    );
    const spent = (state.sessions ?? []).reduce((sum, entry) => sum + entry.ms, 0);
    assert.ok(spent <= 300_000, `the hour spent ${spent} ms`);
  });
});

test("a read the hourly ceiling cuts short is a budget stop: a healthy hour is never counted slow", async () => {
  await seriesFixture(async (f) => {
    await f.row();
    await preexisting(f, rows(6, 3));
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    let limit = Infinity;
    // Every hour's warming read costs 900 ms, well inside its own 2 s limit; past a shorter limit
    // it is cancelled.
    const db: HistoryDatabase = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("set_config('synchronous_commit'"))
          limit = Number.parseInt(String(values![0]));
        if (text.includes("hour_limit")) {
          clock.at += Math.min(900, limit);
          if (limit < 900)
            throw Object.assign(new Error("canceling statement due to statement timeout"), {
              code: "57014",
            });
        }
        return f.db.query(text, values);
      },
    };
    const stored = new Map<string, unknown>();
    // 299.5 s of the hourly 300 s is already spent, so the session has 500 ms.
    stored.set(usageRollupAutoKey, {
      sessions: [{ at: clock.at - 10 * minute, ms: 299_500, walBytes: 0 }],
    });
    const storage = {
      get: async <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
    };
    const state = await usageRollupTick(storage, (work) => work(db), { now: () => clock.at });
    assert.equal(state.lastStop, "budget");
    assert.equal(state.lastHour, undefined);
    assert.equal(state.pausedUntil, undefined);
    assert.deepEqual(state.slow ?? [], []);
    assert.deepEqual(usageRollupStuckPools(state), []);
  });
});
