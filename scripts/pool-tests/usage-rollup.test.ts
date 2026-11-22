import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import {
  handleUsageRollupOperation,
  planUsageRollup,
  runUsageRollup,
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
    await f.db.query("ALTER TABLE basalt_model_requests ENABLE TRIGGER basalt_model_usage_rollup");
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
    await f.db.query("ALTER TABLE basalt_model_requests ENABLE TRIGGER basalt_model_usage_rollup");
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
    for (const hourLimitMs of [249, 451, 5_000, "300"])
      assert.equal(
        (await post({ go: true, plan: dry.plan, digest: dry.digest, hourLimitMs })).status,
        400,
      );
    const applied = (await (
      await post({ go: true, plan: dry.plan, digest: dry.digest, hourLimitMs: 450 })
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
    await f.db.query("ALTER TABLE basalt_model_requests ENABLE TRIGGER basalt_model_usage_rollup");
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
    const resumed = await runUsageRollup(f.db, plan, 60_000);
    assert.equal(resumed.status, "complete");
    assert.deepEqual((await f.db.query(rolled)).rows, (await f.db.query(raw)).rows);
  });
});
