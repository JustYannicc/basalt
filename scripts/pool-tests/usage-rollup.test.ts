import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import {
  withHistoryDatabase,
  type HistoryDatabaseClient,
} from "../../src/pool/model-history/database.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import {
  handleUsageRollupOperation,
  planUsageRollup,
  runUsageRollup,
  usageRollupHoldLimitMs,
} from "../../src/pool/model-history/usage-rollup-backfill.ts";
import { insertRequests } from "../../src/pool/model-history/store.ts";
import { seriesFixture } from "./series-fixture.ts";

/** The raw answer the rollup must reproduce exactly: one group per pool, UTC hour, source and model. */
const raw = `SELECT pool,date_trunc('hour',timestamp) AS hour,source,provider,model,
    count(*)::text AS requests,nullif(count(*) FILTER (WHERE failed),0)::text AS failed,
    sum(input_tokens)::text AS input,sum(output_tokens)::text AS output,
    sum(total_tokens)::text AS total,max(timestamp_exact) AS last_at
  FROM basalt_model_requests GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;
const rolled = `SELECT pool,hour,source,provider,model,
    sum(requests)::text AS requests,(sum(requests) FILTER (WHERE failed))::text AS failed,
    sum(input_tokens_sum)::text AS input,sum(output_tokens_sum)::text AS output,
    sum(total_tokens_sum)::text AS total,max(last_at) AS last_at
  FROM basalt_model_usage_hourly GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;

test("every insert into the request history keeps the hourly rollup identical to the raw rows", async () => {
  await seriesFixture(async (f) => {
    await f.insert(
      ...[0, 1, 2, 3, 4, 5].map((i) => ({
        timestamp: timestamp(`2026-01-01T0${i % 3}:1${i}:00Z`),
        provider: "fixture-lab",
        model: `fixture-model-${i % 2}`,
        inputTokens: String(100 + i),
        outputTokens: String(20 + i),
        totalTokens: String(120 + 2 * i),
        tokenQuality: "complete" as const,
        failed: i === 4,
      })),
    );
    // A second statement that repeats one identity inserts nothing for it and must not count it twice.
    const [first] = await f.insert({ timestamp: timestamp("2026-01-01T05:00:00Z") });
    await f.insert({ ...first, timestamp: timestamp("2026-01-01T05:00:00Z") });
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

const rows = (hours: number, perHour: number, start = "2026-01-01T00:00:00Z") =>
  Array.from({ length: hours * perHour }, (_, i) => ({
    timestamp: timestamp(
      new Date(
        Date.parse(start) + Math.floor(i / perHour) * 3_600_000 + (i % perHour) * 1_000,
      ).toISOString(),
    ),
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
const recompute = (f: { db: { query: Function } }, poolId: string, from: string, to: string) =>
  f.db.query("SELECT basalt_model_usage_recompute($1,$2::timestamptz,$3::timestamptz)", [
    poolId,
    from,
    to,
  ]);

test("a backfill recomputes rows that predate the trigger, and resumes where it stopped", async () => {
  await seriesFixture(async (f) => {
    const poolId = String((await f.row()).pool);
    // Rows written before the trigger existed, as production's retained history is.
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
    await f.insert(...rows(48, 3));
    await f.db.query(
      "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_rollup",
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int AS n FROM basalt_model_usage_hourly")).rows[0]!.n,
      0,
    );
    // A recompute can be repeated; the first day twice, then the job stops.
    await recompute(f, poolId, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");
    await recompute(f, poolId, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");
    assert.notDeepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
    // Written while the job is stopped, into a day it has not reached and one it has.
    await f.insert(...rows(1, 2, "2026-01-02T05:00:00Z"), ...rows(1, 2, "2026-01-01T05:00:00Z"));
    await recompute(f, poolId, "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z");
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
    const hours = await f.db.query("SELECT count(*)::int AS n FROM basalt_model_usage_hours");
    assert.equal(hours.rows[0]!.n, 48);
  });
});

test("rows a writer inserts while an hour is being recomputed are counted once, in either order", async () => {
  await seriesFixture(async (f) => {
    const poolId = String((await f.row()).pool);
    await f.insert(...rows(2, 4));
    const other = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await other.connect();
    try {
      await other.query(`SET search_path TO ${f.schema}`);
      // A writer inside the hour first: the recompute waits for it and then reads its rows.
      await f.db.query("BEGIN");
      await f.insert(...rows(1, 3, "2026-01-01T00:30:00Z"));
      let recomputed = false;
      const waiting = recompute(
        { db: other },
        poolId,
        "2026-01-01T00:00:00Z",
        "2026-01-01T02:00:00Z",
      ).then(() => (recomputed = true));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(recomputed, false, "the recompute waits for the writer inside its hours");
      await f.db.query("COMMIT");
      await waiting;
      assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
      // The recompute first: the writer waits for it and then adds its rows on top.
      await other.query("BEGIN");
      await recompute({ db: other }, poolId, "2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z");
      let written = false;
      const writing = f.insert(...rows(1, 3, "2026-01-01T01:40:00Z")).then(() => (written = true));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(written, false, "the writer waits for the recompute of its hour");
      await other.query("COMMIT");
      await writing;
      assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      await other.end();
    }
  });
});

test("one insert statement spanning thousands of hours keeps the rollup without exhausting locks", async () => {
  await seriesFixture(async (f) => {
    // A bulk import chunk can cover months; the trigger takes one lock per pool, not per hour.
    // Two such chunks in one transaction: 10,000 hours, more than a default shared lock table holds.
    await f.db.query("BEGIN");
    await insertBulkRequests(f.db, await Promise.all(rows(5_000, 1).map((value) => f.row(value))));
    await insertBulkRequests(
      f.db,
      await Promise.all(rows(5_000, 1, "2026-08-01T00:00:00Z").map((value) => f.row(value))),
    );
    await f.db.query("COMMIT");
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("the operator endpoint dry-runs without writes, refuses a changed plan, and applies to ready", async () => {
  await seriesFixture(async (f) => {
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
    await f.insert(...rows(30, 2));
    await f.db.query(
      "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_rollup",
    );
    const url = "http://pool-operations/model-history/usage-rollup";
    const dry = (await (await handleUsageRollupOperation(new Request(url), f.db)).json()) as {
      status: string;
      writes: boolean;
      digest: string;
      plan: { pools: { pool: string; from: string; to: string; days: number }[] };
    };
    assert.equal(dry.status, "dry-run");
    assert.equal(dry.writes, false);
    assert.equal(
      (await f.db.query("SELECT count(*)::int AS n FROM basalt_model_usage_hours")).rows[0]!.n,
      0,
    );
    const post = (body: unknown) =>
      handleUsageRollupOperation(
        new Request(url, { method: "POST", body: JSON.stringify(body) }),
        f.db,
      );
    const changed = {
      ...dry.plan,
      pools: dry.plan.pools.map((p) => ({ ...p, from: p.to, days: 0 })),
    };
    assert.equal((await post({ go: true, plan: changed, digest: dry.digest })).status, 400);
    const tampered = {
      pools: dry.plan.pools.map((p) => ({
        ...p,
        from: new Date(Date.parse(p.from) + 86_400_000).toISOString(),
        days: p.days - 1,
      })),
    };
    assert.equal((await post({ go: true, plan: tampered, digest: dry.digest })).status, 409);
    for (const hourLimitMs of [149, 150, 300, "200"])
      assert.equal(
        (await post({ go: true, plan: dry.plan, digest: dry.digest, hourLimitMs })).status,
        400,
      );
    const applied = (await (
      await post({ go: true, plan: dry.plan, digest: dry.digest })
    ).json()) as {
      status: string;
      pools: { groupsInWindow?: number; groupBound?: number }[];
    };
    assert.equal(applied.status, "complete");
    // The finished pool says how many groups its summary window holds against the bound.
    assert.equal(typeof applied.pools[0]!.groupsInWindow, "number");
    assert.equal(applied.pools[0]!.groupBound, 200_000);
    assert.equal(
      (await f.db.query("SELECT count(*)::int AS n FROM basalt_model_usage_ready")).rows[0]!.n,
      1,
    );
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("the backfill stops at its write-ahead-log budget, yields to a writer holding the pool, and resumes", async () => {
  await seriesFixture(async (f) => {
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
    await f.insert(...rows(6, 2));
    await f.db.query(
      "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_rollup",
    );
    const { plan } = await planUsageRollup(f.db);
    // A one-byte budget: the first hour runs, then the call stops at that hour's boundary.
    const capped = await runUsageRollup(f.db, plan, 60_000, undefined, 1);
    assert.equal(capped.status, "progress");
    assert.equal(capped.stopped, "wal");
    assert.equal(capped.pools[0]!.recomputedHours, 1);
    assert.ok(capped.walBytes > 0);
    // A writer inside the pool: the backfill gives up its lock wait and leaves the hour.
    const writer = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await writer.connect();
    try {
      await writer.query(`SET search_path TO ${f.schema}`);
      await writer.query("BEGIN");
      const row = await f.row({ timestamp: timestamp("2026-01-01T03:30:00Z") });
      await insertRequests(writer, [row]);
      // Even with a 1 ms hour limit, waiting for the writer's lock reads as a lock loss, not a slow hour.
      const yielded = await runUsageRollup(f.db, plan, 60_000, undefined, undefined, 1);
      assert.equal(yielded.stopped, "lock");
      assert.equal(yielded.pools[0]!.recomputedHours, 0);
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK").catch(() => {});
      await writer.end();
    }
    // An hour slower than its limit stops the run, naming the hour, and leaves it pending.
    const slow = await runUsageRollup(f.db, plan, 60_000, undefined, undefined, 1);
    assert.equal(slow.stopped, "slow_hour");
    assert.ok(typeof slow.slowHour === "string");
    // A hold measured over its limit stops the run after that hour, naming it; the hour is done.
    let tick = 0;
    const held = await runUsageRollup(
      f.db,
      plan,
      60_000,
      () => (tick += usageRollupHoldLimitMs + 50),
    );
    assert.equal(held.stopped, "slow_hold");
    assert.ok(typeof held.slowHour === "string");
    assert.equal(held.pools[0]!.recomputedHours, 1);
    assert.ok(held.maxHoldMs > usageRollupHoldLimitMs);
    const resumed = await runUsageRollup(f.db, plan, 60_000);
    assert.equal(resumed.status, "complete");
    assert.ok(resumed.maxHoldMs <= usageRollupHoldLimitMs, `a hold of ${resumed.maxHoldMs} ms`);
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("writers on the 500 ms lock timeout never fail while the backfill runs between them", async () => {
  await seriesFixture(async (f) => {
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
    for (let hour = 0; hour < 48; hour += 8)
      await f.insert(...rows(8, 20, new Date(Date.UTC(2026, 0, 1, hour)).toISOString()));
    await f.db.query(
      "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_rollup",
    );
    const { plan } = await planUsageRollup(f.db);
    const client = async () => {
      const c = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
      await c.connect();
      await c.query(`SET search_path TO ${f.schema}`);
      await c.query("SET lock_timeout = '500ms'");
      return c;
    };
    const holder = await client();
    const quick = await client();
    let running = true,
      slowest = 0,
      written = 0;
    try {
      let n = 0;
      // One writer keeps its transaction, and the pool's shared lock, open 150 ms at a time.
      const holding = (async () => {
        while (running) {
          await holder.query("BEGIN");
          await insertRequests(holder, [
            await f.row({
              timestamp: timestamp(new Date(Date.UTC(2026, 0, 1, n++ % 48, 30)).toISOString()),
            }),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 150));
          await holder.query("COMMIT");
          written++;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      })();
      // Another inserts as fast as it can; any wait past 500 ms fails it.
      const racing = (async () => {
        while (running) {
          const started = performance.now();
          await insertRequests(quick, [
            await f.row({
              timestamp: timestamp(new Date(Date.UTC(2026, 0, 1, n++ % 48, 40)).toISOString()),
            }),
          ]);
          slowest = Math.max(slowest, performance.now() - started);
          written++;
        }
      })();
      let calls = 0;
      for (;;) {
        const result = await runUsageRollup(f.db, plan, 2_000);
        if (result.status === "complete" || ++calls > 500) break;
      }
      running = false;
      await Promise.all([holding, racing]);
      assert.ok(calls <= 500, "the backfill finished between the writers");
      assert.ok(slowest < 500, `the quick writer waited ${Math.round(slowest)} ms`);
      assert.ok(written > 0);
    } finally {
      running = false;
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
      await quick.end();
    }
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("a recompute cancelled inside the operator's bounded session is retried and stops as slow_hour", async () => {
  await seriesFixture(async (f) => {
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
    await f.insert(...rows(6, 2));
    await f.db.query(
      "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_rollup",
    );
    const { plan } = await planUsageRollup(f.db);
    // The operator's own session, which rethrows Postgres's cancel as a history timeout.
    const result = await withHistoryDatabase(
      process.env.POOL_TEST_ADMIN_URL,
      (db) => runUsageRollup(db, plan, 60_000, undefined, undefined, 1),
      {
        createClient: async (connectionString) =>
          new pg.Client({
            connectionString,
            options: `-c search_path=${f.schema}`,
          }) as unknown as HistoryDatabaseClient,
      },
    );
    assert.equal(result.status, "progress");
    assert.equal(result.stopped, "slow_hour");
    assert.equal(typeof result.slowHour, "string");
    assert.equal(result.pools[0]!.recomputedHours, 0);
    const marked = await f.db.query("SELECT count(*)::int AS n FROM basalt_model_usage_hours");
    assert.equal(marked.rows[0]!.n, 0, "a cancelled hour leaves no done-marker");
  });
});

test("a hold past its limit on a pool's last hour ends the call before the next pool", async () => {
  await seriesFixture(async (f) => {
    const first = String((await f.row()).pool);
    const second = "0123456789abcdef";
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
    await f.insert(...rows(1, 2), ...rows(2, 2).map((row) => ({ ...row, pool: second })));
    await f.db.query(
      "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_rollup",
    );
    const at = "2026-01-01T00:00:00.000Z";
    const plan = {
      pools: [
        { pool: first, from: at, to: "2026-01-01T01:00:00.000Z", days: 0 },
        { pool: second, from: at, to: "2026-01-01T02:00:00.000Z", days: 0 },
      ],
    };
    let tick = 0;
    const held = await runUsageRollup(
      f.db,
      plan,
      60_000,
      () => (tick += usageRollupHoldLimitMs + 50),
    );
    assert.equal(held.status, "progress");
    assert.equal(held.stopped, "slow_hold");
    assert.equal(held.slowHour, at);
    assert.equal(held.pools.length, 1, "the next pool is not started");
    assert.equal(held.pools[0]!.remainingHours, 0);
    const later = await f.db.query(
      "SELECT count(*)::int AS n FROM basalt_model_usage_hours WHERE pool=$1",
      [second],
    );
    assert.equal(later.rows[0]!.n, 0);
    const resumed = await runUsageRollup(f.db, plan, 60_000);
    assert.equal(resumed.status, "complete");
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});

test("an import written in replica mode keeps the rollup, racing a backfill without a deadlock", async () => {
  await seriesFixture(async (f) => {
    const trigger = await f.db.query(
      `SELECT tgenabled FROM pg_trigger WHERE tgname='basalt_model_usage_rollup'
        AND tgrelid=to_regclass('basalt_model_requests')`,
    );
    assert.equal(trigger.rows[0]!.tgenabled, "A", "the rollup trigger fires in replica mode too");
    await f.db.query("ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_rollup");
    await f.insert(...rows(24, 4));
    await f.db.query(
      "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_rollup",
    );
    const { plan } = await planUsageRollup(f.db);
    const importer = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await importer.connect();
    try {
      await importer.query(`SET search_path TO ${f.schema}`);
      // Batches into the hours the backfill is recomputing, as the import finish commits a chunk.
      const batches = await Promise.all(
        Array.from({ length: 12 }, async (_, batch) =>
          Promise.all(
            rows(24, 2, "2026-01-01T00:30:00Z").map((row, i) =>
              f.row({ ...row, model: `import-${batch}-${i % 2}` }),
            ),
          ),
        ),
      );
      const imports = (async () => {
        for (const records of batches) {
          await importer.query(
            "BEGIN; SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '10s'",
          );
          try {
            await importer.query("SET LOCAL session_replication_role = replica");
            await insertBulkRequests(importer, records);
            await importer.query("SET LOCAL session_replication_role = origin");
            await importer.query("COMMIT");
          } catch (error) {
            await importer.query("ROLLBACK").catch(() => {});
            throw error;
          }
        }
      })();
      let complete = false;
      for (let call = 0; call < 500 && !complete; call++)
        complete = (await runUsageRollup(f.db, plan, 200)).status === "complete";
      await imports;
      assert.ok(complete, "the backfill finished beside the import");
    } finally {
      await importer.end();
    }
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});
