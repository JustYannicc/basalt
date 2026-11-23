import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { timestamp } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { insertRequests } from "../../src/pool/model-history/store.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { usageRollupReadLimitMs } from "../../src/pool/model-history/usage-rollup-apply.ts";
import {
  usagePeopleRollupAutoKey,
  usageRollupInspect,
  usageRollupStuckPools,
  usageRollupTick,
  type UsageRollupAutoState,
} from "../../src/pool/model-history/usage-rollup-auto.ts";
import {
  handleUsageRollupOperation,
  planUsageRollup,
  runUsageRollup,
} from "../../src/pool/model-history/usage-rollup-backfill.ts";
import { historyUsagePeopleRollupVersion } from "../../src/pool/model-history/usage-rollup-people-schema.ts";
import { usageRollupLockClass } from "../../src/pool/model-history/usage-rollup-schema.ts";
import { pool as poolName, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];

/**
 * The raw answer v16 must reproduce exactly: one group per pool, hour, source, person, app, model,
 * each row in the hour of its exact time, as the rollup keys it.
 */
const raw = `SELECT pool,date_trunc('hour',left(timestamp_exact,19)::timestamp) AT TIME ZONE 'UTC' AS hour,source,person,app_id,provider,model,
    count(*)::text AS requests,nullif(count(*) FILTER (WHERE failed),0)::text AS failed,
    sum(input_tokens)::text AS input,sum(total_tokens)::text AS total,max(timestamp_exact) AS last_at
  FROM basalt_model_requests GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST,
    6 NULLS FIRST,7 NULLS FIRST`;
const people = `SELECT pool,hour,source,person,app_id,provider,model,
    sum(requests)::text AS requests,(sum(requests) FILTER (WHERE failed))::text AS failed,
    sum(input_tokens_sum)::text AS input,sum(total_tokens_sum)::text AS total,max(last_at) AS last_at
  FROM basalt_model_usage_people_hourly GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,2,3,4 NULLS FIRST,
    5 NULLS FIRST,6 NULLS FIRST,7 NULLS FIRST`;
/** Every column of every v16 group, in key order. */
const all = `SELECT * FROM basalt_model_usage_people_hourly ORDER BY ${[
  "pool",
  "hour",
  "source",
  "account",
  "attribution",
  "provider",
  "model",
  "person",
  "app_id",
  "service_tier",
  "api_type",
  "token_quality",
  "failed",
  "limited",
  "cost_basis",
  "currency",
  "price_class",
  "context_band",
]
  .map((key) => `${key} NULLS FIRST`)
  .join(",")}`;
const second = "0123456789abcdef";
const hour = 3_600_000;
const minute = 60_000;
const start = "2026-01-01T00:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(start) + hours * hour).toISOString();

/** `count` requests spread evenly over the hour `from`, keyed by a few people, apps and models. */
const spread = (from: string, count: number, pool?: string) =>
  Array.from({ length: count }, (_, i) => ({
    ...(pool ? { pool } : {}),
    timestamp: timestamp(new Date(Date.parse(from) + Math.floor((i * hour) / count)).toISOString()),
    person: i % 4 === 0 ? null : String(1 + (i % 3)).repeat(64),
    appId: i % 5 === 0 ? null : `fixture-app-${i % 2}`,
    provider: "fixture-lab",
    model: `fixture-model-${i % 3}`,
    inputTokens: String(1_000 + i),
    outputTokens: String(10 + (i % 7)),
    cacheReadTokens: "0",
    cacheWriteTokens: "0",
    totalTokens: String(1_010 + i + (i % 7)),
    tokenQuality: "complete" as const,
    failed: i % 11 === 0,
  }));
const hours = (from: number, count: number, perHour: number, pool?: string) =>
  Array.from({ length: count }, (_, h) => spread(at(from + h), perHour, pool)).flat();

/** Inserts in bounded statements, as captures and imports do. */
async function insert(f: Fixture, rows: readonly object[]) {
  for (let i = 0; i < rows.length; i += 200) await f.insert(...rows.slice(i, i + 200));
}

/** History written before the v16 trigger existed, as production's is. */
async function preexisting(f: Fixture, rows: readonly object[]) {
  await f.db.query(
    "ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_people_rollup",
  );
  await insert(f, rows);
  await f.db.query(
    "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_people_rollup",
  );
}

interface Step {
  kind: "read" | "apply" | "recompute";
  hour: string;
  groups?: number | null;
  heldMs?: number;
}
/** The backfill's statements: each read, each apply with its result, and any recompute. */
function traced(db: HistoryDatabase, steps: Step[], afterRead?: (hour: string) => Promise<void>) {
  return {
    query: async (text: string, values?: unknown[]) => {
      const result = await db.query(text, values);
      if (text.includes("basalt_model_usage_people_recompute"))
        steps.push({ kind: "recompute", hour: String(values?.[1]) });
      if (text.includes("apply_limit")) {
        steps.push({ kind: "read", hour: String(values![1]) });
        await afterRead?.(String(values![1]));
      }
      if (text.includes("basalt_model_usage_people_apply(")) {
        const row = result.rows[0]!;
        steps.push({
          kind: "apply",
          hour: String(values![1]),
          groups: row.groups === null ? null : Number(row.groups),
          heldMs: Number(row.held_ms),
        });
      }
      return result;
    },
  } satisfies HistoryDatabase;
}

const memoryStorage = () => {
  const stored = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
    state: () => stored.get(usagePeopleRollupAutoKey) as UsageRollupAutoState | undefined,
  };
};
const ready = async (db: HistoryDatabase, pool: string) =>
  (await db.query("SELECT 1 FROM basalt_model_usage_people_ready WHERE pool=$1", [pool])).rows
    .length === 1;
const onePlan = (pool: string, from: string, to: string) => ({
  rollup: "v16" as const,
  pools: [{ pool, from, to, days: (Date.parse(to) - Date.parse(from)) / (24 * hour) }],
});

test("every hour the v16 backfill writes through the apply equals a v16 recompute of it, column by column, and raw rows", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    // Rows before the trigger, then more into the same hours after it, merged into its groups.
    await preexisting(f, [
      ...hours(0, 6, 7),
      ...["2026-01-01T02:59:59.999999600Z", "2026-01-01T03:00:00.000000000Z"].map((exact) => ({
        timestamp: timestamp(exact),
        provider: "fixture-lab",
        model: "fixture-model-0",
      })),
    ]);
    await insert(f, hours(1, 3, 4));
    const { plan } = await planUsageRollup(f.db);
    assert.equal(plan.rollup, "v16");
    const steps: Step[] = [];
    const result = await runUsageRollup(traced(f.db, steps), plan, 60_000);
    assert.equal(result.status, "complete", JSON.stringify(result));
    assert.ok(await ready(f.db, pool));
    const pending = plan.pools[0]!.days * 24;
    const applies = steps.filter((step) => step.kind === "apply");
    assert.equal(applies.length, pending, "one apply an hour, every one of them accepted");
    assert.ok(applies.every((step) => (step.groups ?? -1) >= 0));
    assert.deepEqual(
      steps.filter((step) => step.kind === "recompute"),
      [],
      "the v16 backfill never recomputes",
    );
    const applied = (await f.db.query(all)).rows;
    assert.ok(applied.length > 0);
    await f.db.query("SELECT basalt_model_usage_people_recompute($1,$2,$3)", [
      pool,
      plan.pools[0]!.from,
      plan.pools[0]!.to,
    ]);
    assert.deepEqual((await f.db.query(all)).rows, applied, "every sum, count and time column");
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
  });
});

test("a row landing between the read and the apply makes the apply refuse; the hour is read again and never written stale", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, hours(0, 1, 5));
    const writer = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await writer.connect();
    try {
      await writer.query(`SET search_path TO ${f.schema}`);
      let landed = false;
      const steps: Step[] = [];
      // A capture commits a row into the hour right after the backfill's read of it returns.
      const db = traced(f.db, steps, async (read) => {
        if (landed || read !== start) return;
        landed = true;
        await insertRequests(writer, [
          await f.row({ timestamp: timestamp("2026-01-01T00:30:00.5Z"), model: "fixture-late" }),
        ]);
      });
      const result = await runUsageRollup(db, onePlan(pool, start, at(1)), 60_000);
      assert.equal(result.status, "complete", JSON.stringify(result));
      assert.deepEqual(
        steps.map((step) => [step.kind, step.kind === "apply" ? Math.sign(step.groups!) : null]),
        [
          ["read", null],
          ["apply", -1],
          ["read", null],
          ["apply", 1],
        ],
        "refused once, then read again and applied",
      );
      assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
      const late = await f.db.query(
        "SELECT sum(requests)::int AS n FROM basalt_model_usage_people_hourly WHERE model='fixture-late'",
      );
      assert.equal(late.rows[0]!.n, 1, "the late row is in the rollup");
    } finally {
      await writer.end();
    }
  });
});

test("rows that keep landing between read and apply stop the call as changing, which counts like a lost lock", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, hours(0, 1, 5));
    const writer = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await writer.connect();
    try {
      await writer.query(`SET search_path TO ${f.schema}`);
      let late = 0;
      const steps: Step[] = [];
      // A row lands in the hour after every read of it.
      const db = traced(f.db, steps, async (read) =>
        insertRequests(writer, [
          await f.row({
            timestamp: timestamp(
              new Date(Date.parse(read) + 30 * minute + ++late * 1_000).toISOString(),
            ),
          }),
        ]).then(() => undefined),
      );
      const clock = Date.parse("2026-02-01T00:00:00Z");
      const state = await usageRollupTick(memoryStorage(), (work) => work(db), {
        now: () => clock,
        bounds: { sessions: 1 },
      });
      const first = "2025-12-31T00:00:00.000Z";
      assert.equal(state.lastStop, "changing");
      assert.equal(state.lastHour, first);
      assert.equal(state.lastHourPhase, "apply");
      assert.equal(state.pausedUntil, new Date(clock + hour).toISOString(), "paused like a lock");
      assert.deepEqual(state.repeat, { pool, reason: "lock", count: 1 });
      assert.deepEqual(
        steps.filter((step) => step.kind === "apply").map((step) => step.groups),
        [-1, -1, -1, -1, -1],
        "five refusals, then it stops",
      );
      const hourly = await f.db.query(
        `SELECT (SELECT coalesce(sum(requests),0)::int FROM basalt_model_usage_people_hourly
            WHERE pool=$1 AND hour=$2) AS requests,
          (SELECT count(*)::int FROM basalt_model_usage_people_hours WHERE pool=$1) AS marked`,
        [pool, first],
      );
      assert.deepEqual(hourly.rows[0], { requests: 5, marked: 0 }, "only the trigger wrote it");
    } finally {
      await writer.end();
    }
  });
});

test("the apply's hold under the lock stays far inside its limit whether the hour has 500 rows or 13,605", async (t) => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, [...spread(at(0), 500), ...spread(at(1), 13_605)]);
    await f.db.query("ANALYZE basalt_model_requests");
    const steps: Step[] = [];
    const result = await runUsageRollup(traced(f.db, steps), onePlan(pool, start, at(2)), 60_000);
    assert.equal(result.status, "complete", JSON.stringify(result));
    const [light, dense] = steps.filter((step) => step.kind === "apply");
    t.diagnostic(
      `server hold: 500 rows ${light!.heldMs!.toFixed(2)} ms over ${light!.groups} groups, ` +
        `13,605 rows ${dense!.heldMs!.toFixed(2)} ms over ${dense!.groups} groups`,
    );
    // The aggregate is read outside the lock, so the hold is the compare and the write of the
    // groups, never the scan of the rows: a recompute under the lock held 13,605 rows for ~60 ms here.
    for (const step of [light!, dense!])
      assert.ok(step.heldMs! < 25, `held ${step.heldMs} ms for ${step.hour}`);
    assert.ok(
      dense!.heldMs! < 3 * light!.heldMs! + 5,
      "the dense hour holds no longer than the light",
    );
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
  });
});

test("a pool becomes ready on v16 by ticks alone, and then its summary and series equal raw rows", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    const pool = String((await f.row()).pool);
    await f.db.query(
      "ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_people_rollup",
    );
    let id = 0;
    for (let day = 0; day < 3; day++)
      for (let h = 0; h < 24; h += 3) {
        const time = (m: number) => new Date(Date.UTC(2026, 0, 1 + day, h, m, 7)).toISOString();
        await fixture.native(++id, time(1), { model: "fixture-model-0", person: "1".repeat(64) });
        await fixture.native(++id, time(2), {
          model: "fixture-model-1",
          appId: "fixture-app-0",
          inputTokens: String(150_000 + day * 40_000),
          totalTokens: String(150_020 + day * 40_000),
        });
        await fixture.native(++id, time(3), { failed: true, statusCode: 429 });
      }
    await f.db.query(
      "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_people_rollup",
    );
    await fixture.cursor(id);
    await fixture.analyze();
    const read = async (db: HistoryDatabase) => {
      const statements: string[][] = [[], []];
      const counted = (index: number): HistoryDatabase => ({
        query: (text, values) => {
          statements[index]!.push(text);
          return db.query(text, values);
        },
      });
      const to = "2026-01-03T22:10:00.000000123Z";
      const summary = await poolUsageSummary(
        counted(0),
        {
          pool: poolName,
          from: "2026-01-01T01:30:00Z",
          to,
          by: "model",
          authority: fixture.authority,
        },
        async () => ({ prices: summaryPrices, issues: [] }),
        Date.parse(to),
      );
      const series = await poolUsageSeries(
        counted(1),
        {
          pool: poolName,
          from: "2026-01-01T01:30:00Z",
          to,
          bucket: "hour",
          by: ["person", "app", "model"],
        },
        fixture.authority,
      );
      return {
        summary: JSON.parse(
          JSON.stringify(summary, (key, value) =>
            key === "capturedAt" || key === "asOf" ? "read time" : value,
          ),
        ),
        series,
        // The summary's coverage statement, and any series statement, name the rollup they read.
        rolled: [
          statements[0]![3]!.includes("basalt_model_usage_people_hourly"),
          statements[1]!.some((text) => text.includes("basalt_model_usage_people_hourly")),
        ],
      };
    };
    const before = await read(f.db);
    assert.deepEqual(before.rolled, [false, false], "not ready: raw rows");
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    for (let i = 0; i < 20 && !(await ready(f.db, pool)); i++) {
      await usageRollupTick(storage, (work) => work(f.db), { now: () => (clock += 1) });
      clock += 5 * minute;
    }
    assert.ok(await ready(f.db, pool), "ready on v16 by ticks alone");
    assert.equal(storage.state()!.rollup, "v16");
    const after = await read(f.db);
    assert.deepEqual(after.rolled, [true, true], "ready: the v16 rollup");
    assert.deepEqual(after.summary, before.summary);
    assert.deepEqual(after.series, before.series);
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
  });
});

test("a 9,299-row hour right after a 5,230-row hour at a pool's head goes through with no special case, and the next pool is not delayed", async () => {
  await seriesFixture(async (f) => {
    const [a, b] = [String((await f.row()).pool), second].sort() as [string, string];
    await preexisting(f, [
      ...spread(at(0), 5_230, a),
      ...spread(at(1), 9_299, a),
      ...hours(2, 4, 6, a),
      ...hours(0, 3, 4, b),
    ]);
    await f.db.query("ANALYZE basalt_model_requests");
    // Test-only: a v16 recompute far too slow for any lock, which the backfill must never call.
    await f.db.query(`CREATE OR REPLACE FUNCTION basalt_model_usage_people_recompute(
        target_pool varchar, from_hour timestamptz, to_hour timestamptz) RETURNS bigint
      LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_sleep(1);
        RAISE EXCEPTION 'the v16 backfill called the recompute';
      END $$`);
    const storage = memoryStorage();
    let clock = Date.parse("2026-02-01T00:00:00Z");
    const tick = () => usageRollupTick(storage, (work) => work(f.db), { now: () => clock });
    const first = await tick();
    assert.ok(await ready(f.db, a), `ready in its first tick: ${JSON.stringify(first.lastStop)}`);
    clock += 5 * minute;
    const next = await tick();
    assert.ok(await ready(f.db, b), "the next pool is ready on the very next tick");
    for (const state of [first, next]) {
      assert.equal(state.pausedUntil, undefined);
      assert.deepEqual(state.slow ?? [], []);
      assert.deepEqual(usageRollupStuckPools(state), []);
    }
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
  });
});

test("the apply runs only under the try-lock: beside a writer holding the pool it refuses at once and writes nothing", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, hours(0, 1, 5));
    const writer = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await writer.connect();
    const written = async () =>
      (
        await f.db.query(
          `SELECT (SELECT count(*)::int FROM basalt_model_usage_people_hourly) AS groups,
            (SELECT count(*)::int FROM basalt_model_usage_people_hours) AS hours`,
        )
      ).rows[0];
    try {
      await writer.query(`SET search_path TO ${f.schema}`);
      // As a writer inside the pool holds it: the pool's shared lock, in an open transaction.
      await writer.query("BEGIN");
      await writer.query("SELECT pg_advisory_xact_lock_shared($1,hashtext($2))", [
        usageRollupLockClass,
        pool,
      ]);
      const started = performance.now();
      const result = await runUsageRollup(f.db, onePlan(pool, start, at(1)), 60_000);
      const took = performance.now() - started;
      assert.equal(result.stopped, "lock", "it never waits for the writer");
      // Five refusals 50 ms apart; an apply that queued for the lock would wait for the writer.
      assert.ok(took < 1_500, `the call took ${Math.round(took)} ms`);
      assert.deepEqual(await written(), { groups: 0, hours: 0 });
      // Called directly, the function itself only try-locks: no wait, no write.
      await f.db.query("BEGIN");
      await f.db.query("SET LOCAL statement_timeout = '1s'");
      const direct = await f.db.query(
        "SELECT basalt_model_usage_people_apply($1,$2::timestamptz,0,'[]'::jsonb) AS groups",
        [pool, start],
      );
      await f.db.query("ROLLBACK");
      assert.equal(direct.rows[0]!.groups, null, "refused");
      assert.deepEqual(await written(), { groups: 0, hours: 0 });
      await writer.query("COMMIT");
      assert.equal(
        (await runUsageRollup(f.db, onePlan(pool, start, at(1)), 60_000)).status,
        "complete",
        "once the writer commits, the hour applies",
      );
    } finally {
      await writer.query("ROLLBACK").catch(() => {});
      await writer.end();
    }
  });
});

/**
 * The test's clock, as production spends it: a read of `pool` costs `cost.ms`, but never more than
 * the limit it was given, past which Postgres cancels it.
 */
function timed(db: HistoryDatabase, pool: string, cost: { ms: number }, clock: { at: number }) {
  let limit = Number.POSITIVE_INFINITY;
  return {
    query: async (text: string, values?: unknown[]) => {
      if (text.includes("set_config('synchronous_commit'"))
        limit = Number.parseInt(String(values![0]));
      if (text.includes("apply_limit") && values![0] === pool) {
        clock.at += Math.min(cost.ms, limit);
        if (limit < cost.ms)
          throw Object.assign(new Error("canceling statement due to statement timeout"), {
            code: "57014",
          });
      }
      return db.query(text, values);
    },
  } satisfies HistoryDatabase;
}

test("a read past its own limit is slow_read: only its pool waits, three in a row is stuck and loud once, and it is retried every wait", async (t) => {
  const stuckLog = t.mock.method(console, "error", () => {});
  await seriesFixture(async (f) => {
    const [a, b] = [String((await f.row()).pool), second].sort() as [string, string];
    await preexisting(f, [...hours(0, 3, 3, a), ...hours(0, 3, 2, b)]);
    const cost = { ms: usageRollupReadLimitMs + 1_000 };
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const storage = memoryStorage();
    const tick = () =>
      usageRollupTick(storage, (work) => work(timed(f.db, a, cost, clock)), {
        now: () => clock.at,
      });
    const slowHour = "2025-12-31T00:00:00.000Z";
    const first = await tick();
    assert.ok(await ready(f.db, b), "the other pool went on in the same tick");
    assert.equal(first.pausedUntil, undefined, "a slow read never pauses the tick");
    assert.deepEqual(first.slow, [
      { pool: a, hour: slowHour, count: 1, until: new Date(clock.at + 10 * minute).toISOString() },
    ]);
    assert.equal(first.totalPendingHours, 48, "the slow pool's hours are all that is left");
    clock.at += 5 * minute;
    const waiting = await tick();
    assert.equal(waiting.lastStop, "waiting");
    assert.equal(waiting.slow?.[0]?.count, 1, "not tried while it waits");
    clock.at += 5 * minute + 1_000;
    assert.equal((await tick()).slow?.[0]?.count, 2);
    clock.at += 10 * minute + 1_000;
    const stuck = await tick();
    assert.deepEqual(usageRollupStuckPools(stuck), [a]);
    assert.deepEqual(stuck.stuck, [
      { pool: a, reason: "slow", hour: slowHour, retryAt: stuck.slow![0]!.until },
    ]);
    const inspected = usageRollupInspect(stuck);
    assert.deepEqual(
      [inspected.lastHour, inspected.lastHourPhase, inspected.lastHourReadMs],
      [slowHour, "read", usageRollupReadLimitMs],
    );
    clock.at += 10 * minute + 1_000;
    const retried = await tick();
    assert.equal(retried.slow?.[0]?.count, 4, "retried after its wait, not a day out");
    const loud = () =>
      stuckLog.mock.calls.filter((call) => call.arguments[0] === "POOL_USAGE_ROLLUP_STUCK");
    assert.deepEqual(
      loud().map((call) => call.arguments[1]),
      [{ reason: "slow", hour: slowHour }],
      "loud once, naming the hour",
    );
    // Once its read fits, the next tick after the wait finishes the pool and clears it.
    cost.ms = 0;
    clock.at += 10 * minute + 1_000;
    const done = await tick();
    assert.ok(await ready(f.db, a));
    assert.deepEqual(usageRollupStuckPools(done), []);
    assert.deepEqual(done.slow, []);
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
  });
});

test("a read the budget cuts short of its own limit is a budget stop: a healthy hour is never slow", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, hours(0, 3, 3));
    // Every read costs 2 s, well inside its 5 s limit; the session has 1 s.
    const clock = { at: Date.parse("2026-02-01T00:00:00Z") };
    const storage = memoryStorage();
    const state = await usageRollupTick(
      storage,
      (work) => work(timed(f.db, pool, { ms: 2_000 }, clock)),
      { now: () => clock.at, bounds: { sessions: 1, sessionMs: 1_000 } },
    );
    assert.equal(state.lastStop, "budget");
    assert.equal(state.lastHour, undefined);
    assert.equal(state.pausedUntil, undefined);
    assert.deepEqual(state.slow ?? [], []);
    assert.deepEqual(usageRollupStuckPools(state), []);
    // With the whole session, the same 2 s read goes through.
    const result = await runUsageRollup(
      timed(f.db, pool, { ms: 2_000 }, clock),
      onePlan(pool, start, at(1)),
      12_000,
      () => clock.at,
    );
    assert.equal(result.status, "complete", JSON.stringify(result));
  });
});

test("the v16 span ends at the hour after the trigger's install hour: that hour comes out equal to raw rows, later ones are never touched", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    // As the migration's own record says: v16 was installed at 03:20.
    await f.db.query(
      "UPDATE basalt_model_history_migrations SET completed_at='2026-01-01T03:20:00Z' WHERE name=$1",
      [historyUsagePeopleRollupVersion],
    );
    const row = (exact: string, model: string) => ({
      timestamp: timestamp(exact),
      provider: "fixture-lab",
      model,
      inputTokens: "100",
      totalTokens: "110",
    });
    // Before the install: three whole hours and the start of the install hour.
    await preexisting(f, [
      ...hours(0, 3, 4),
      row("2026-01-01T03:05:00Z", "before-install"),
      row("2026-01-01T03:10:00Z", "before-install"),
    ]);
    // After it, through the trigger: the rest of the install hour and two later hours.
    await insert(f, [
      row("2026-01-01T03:40:00Z", "after-install"),
      row("2026-01-01T03:50:00Z", "before-install"),
      ...hours(4, 2, 4),
    ]);
    const steps: Step[] = [];
    const db = traced(f.db, steps);
    const url = "http://pool-operations/model-history/usage-rollup";
    const dry = (await (await handleUsageRollupOperation(new Request(url), db)).json()) as {
      digest: string;
      plan: { rollup: string; pools: { to: string }[] };
    };
    assert.equal(dry.plan.pools[0]!.to, at(4), "the span ends where the trigger took over");
    const applied = (await (
      await handleUsageRollupOperation(
        new Request(url, {
          method: "POST",
          body: JSON.stringify({ go: true, plan: dry.plan, digest: dry.digest }),
        }),
        db,
      )
    ).json()) as { status: string };
    assert.equal(applied.status, "complete");
    assert.ok(await ready(f.db, pool));
    const through = await f.db.query(
      "SELECT through FROM basalt_model_usage_people_ready WHERE pool=$1",
      [pool],
    );
    assert.equal((through.rows[0]!.through as Date).toISOString(), at(4));
    assert.deepEqual(
      steps.filter((step) => step.hour >= at(4)),
      [],
      "no read or apply after the install hour",
    );
    const marked = await f.db.query(
      "SELECT count(*)::int AS n FROM basalt_model_usage_people_hours WHERE pool=$1 AND hour >= $2",
      [pool, at(4)],
    );
    assert.equal(marked.rows[0]!.n, 0, "no hour after it is marked");
    assert.ok(steps.some((step) => step.kind === "apply" && step.hour === at(3)));
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
  });
});

test("an apply that keeps running past its limit with a short hold names its hour as slow, not an error", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await preexisting(f, hours(0, 3, 4));
    // Test-only: writing the second hour's groups sleeps past the apply's limit, so every apply
    // of that hour is cancelled while its hold stays short of the hold limit.
    await f.db
      .query(`CREATE FUNCTION slow_apply_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.pool = '${pool}' AND NEW.hour = '${at(1)}'::timestamptz THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END $$`);
    await f.db
      .query(`CREATE TRIGGER slow_apply_fixture BEFORE INSERT ON basalt_model_usage_people_hourly
      FOR EACH ROW EXECUTE FUNCTION slow_apply_fixture()`);
    const { plan } = await planUsageRollup(f.db);
    const result = await runUsageRollup(f.db, plan, 60_000);
    assert.equal(result.stopped, "slow_hour", JSON.stringify(result));
    assert.equal(result.slowHour, at(1));
    assert.equal(
      result.pools[0]!.recomputedHours,
      (Date.parse(at(1)) - Date.parse(plan.pools[0]!.from)) / hour,
      "every hour before it committed",
    );
    await f.db.query("DROP TRIGGER slow_apply_fixture ON basalt_model_usage_people_hourly");
    const rerun = await runUsageRollup(f.db, (await planUsageRollup(f.db)).plan, 60_000);
    assert.equal(rerun.status, "complete", JSON.stringify(rerun));
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
  });
});

test("the span end's margin: an install late in its hour ends the span an hour later", async () => {
  await seriesFixture(async (f) => {
    await f.row();
    await f.db.query(
      "UPDATE basalt_model_history_migrations SET completed_at='2026-01-01T03:57:00Z' WHERE name=$1",
      [historyUsagePeopleRollupVersion],
    );
    await preexisting(f, hours(0, 4, 2));
    const { plan } = await planUsageRollup(f.db);
    assert.equal(plan.pools[0]!.to, at(5), "03:57 plus the margin is in the 04:00 hour");
  });
});
