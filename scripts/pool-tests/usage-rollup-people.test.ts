import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import {
  usagePeopleRollupAutoKey,
  usageRollupAutoKey,
  usageRollupAutoState,
  usageRollupInspect,
  usageRollupTick,
  type UsageRollupAutoState,
} from "../../src/pool/model-history/usage-rollup-auto.ts";
import {
  handleUsageRollupOperation,
  runUsageRollup,
} from "../../src/pool/model-history/usage-rollup-backfill.ts";
import { seriesFixture, withoutPeopleRollup } from "./series-fixture.ts";

/** The raw answer v16 must reproduce exactly: one group per pool, hour, source, person, app, model. */
const raw = `SELECT pool,date_trunc('hour',timestamp) AS hour,source,person,app_id,provider,model,
    count(*)::text AS requests,nullif(count(*) FILTER (WHERE failed),0)::text AS failed,
    sum(input_tokens)::text AS input,sum(total_tokens)::text AS total,max(timestamp_exact) AS last_at
  FROM basalt_model_requests GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST,
    6 NULLS FIRST,7 NULLS FIRST`;
const people = `SELECT pool,hour,source,person,app_id,provider,model,
    sum(requests)::text AS requests,(sum(requests) FILTER (WHERE failed))::text AS failed,
    sum(input_tokens_sum)::text AS input,sum(total_tokens_sum)::text AS total,max(last_at) AS last_at
  FROM basalt_model_usage_people_hourly GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,2,3,4 NULLS FIRST,
    5 NULLS FIRST,6 NULLS FIRST,7 NULLS FIRST`;
/** v15 keeps its own answer through the transition: both triggers fire on every insert. */
const v15Raw = `SELECT pool,date_trunc('hour',timestamp) AS hour,source,provider,model,
    count(*)::text AS requests,sum(input_tokens)::text AS input
  FROM basalt_model_requests GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;
const v15 = `SELECT pool,hour,source,provider,model,
    sum(requests)::text AS requests,sum(input_tokens_sum)::text AS input
  FROM basalt_model_usage_hourly GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4 NULLS FIRST,5 NULLS FIRST`;
const person = (i: number) => String(1 + (i % 3)).repeat(64);

const rows = (hours: number, perHour: number, start = "2026-01-01T00:00:00Z") =>
  Array.from({ length: hours * perHour }, (_, i) => ({
    timestamp: timestamp(
      new Date(
        Date.parse(start) + Math.floor(i / perHour) * 3_600_000 + (i % perHour) * 1_000,
      ).toISOString(),
    ),
    person: i % 4 === 0 ? null : person(i),
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

const disabled = async (db: { query: Function }, work: () => Promise<unknown>) => {
  await db.query(
    "ALTER TABLE basalt_model_requests DISABLE TRIGGER basalt_model_usage_people_rollup",
  );
  await work();
  await db.query(
    "ALTER TABLE basalt_model_requests ENABLE ALWAYS TRIGGER basalt_model_usage_people_rollup",
  );
};

test("every insert keeps the v16 rollup identical to raw rows by person and app, and v15 too", async () => {
  await seriesFixture(async (f) => {
    await f.insert(...rows(3, 5));
    // A repeated identity inserts nothing and must not count twice.
    const [first] = await f.insert({ timestamp: timestamp("2026-01-01T05:00:00Z") });
    await f.insert({ ...first, timestamp: timestamp("2026-01-01T05:00:00Z") });
    // A bulk import chunk, and one written in replica mode as an import finish writes.
    await insertBulkRequests(
      f.db,
      await Promise.all(rows(30, 1, "2026-02-01T00:00:00Z").map((row) => f.row(row))),
    );
    const trigger = await f.db.query(
      `SELECT tgenabled FROM pg_trigger WHERE tgname='basalt_model_usage_people_rollup'
        AND tgrelid=to_regclass('basalt_model_requests')`,
    );
    assert.equal(trigger.rows[0]!.tgenabled, "A", "the v16 trigger fires in replica mode too");
    await f.db.query("BEGIN; SET LOCAL session_replication_role = replica");
    await insertBulkRequests(
      f.db,
      await Promise.all(rows(2, 3, "2026-03-01T00:00:00Z").map((row) => f.row(row))),
    );
    await f.db.query("COMMIT");
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
    assert.deepEqual((await f.db.query(v15)).rows, (await f.db.query(v15Raw)).rows);
    assert.ok(
      (await f.db.query(raw)).rows.some((row) => row.person !== null && row.app_id !== null),
    );
  });
});

test("v16 applied to existing history copies no row, and both rollups count what follows", async () => {
  await seriesFixture(async (f) => {
    await withoutPeopleRollup(f.db);
    await f.insert(...rows(4, 3));
    await migrateModelHistory(f.db);
    assert.equal(
      (await f.db.query("SELECT count(*)::int AS n FROM basalt_model_usage_people_hourly")).rows[0]!
        .n,
      0,
      "the migration backfills nothing",
    );
    await f.insert(...rows(2, 3, "2026-01-02T00:00:00Z"));
    assert.equal(
      (
        await f.db.query(
          "SELECT sum(requests)::int AS n FROM basalt_model_usage_people_hourly WHERE hour >= '2026-01-02'",
        )
      ).rows[0]!.n,
      6,
    );
    assert.deepEqual((await f.db.query(v15)).rows, (await f.db.query(v15Raw)).rows);
  });
});

test("once v16 is applied the operator's dry run plans v16 and its apply makes the pool ready on v16", async () => {
  await seriesFixture(async (f) => {
    await disabled(f.db, () => f.insert(...rows(30, 2)));
    const url = "http://pool-operations/model-history/usage-rollup";
    const dry = (await (await handleUsageRollupOperation(new Request(url), f.db)).json()) as {
      writes: boolean;
      digest: string;
      plan: { rollup: string; pools: unknown[] };
    };
    assert.equal(dry.writes, false);
    assert.equal(dry.plan.rollup, "v16");
    const post = (body: unknown) =>
      handleUsageRollupOperation(
        new Request(url, { method: "POST", body: JSON.stringify(body) }),
        f.db,
      );
    // The rollup is part of the approved plan: changing it changes the digest.
    assert.equal(
      (await post({ go: true, plan: { ...dry.plan, rollup: "v15" }, digest: dry.digest })).status,
      409,
    );
    assert.equal(
      (await post({ go: true, plan: { ...dry.plan, rollup: "v17" }, digest: dry.digest })).status,
      400,
    );
    const applied = (await (
      await post({ go: true, plan: dry.plan, digest: dry.digest })
    ).json()) as {
      status: string;
    };
    assert.equal(applied.status, "complete");
    const count = async (table: string) =>
      (await f.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
    assert.equal(await count("basalt_model_usage_people_ready"), 1);
    assert.equal(await count("basalt_model_usage_ready"), 0, "v15 is left alone");
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
    // A plan from before v16 names no rollup and still means v15.
    const v15Plan = await runUsageRollup(f.db, {
      pools: [
        {
          pool: String((await f.row()).pool),
          from: "2025-12-31T00:00:00.000Z",
          to: "2026-01-03T00:00:00.000Z",
          days: 3,
        },
      ],
    });
    assert.equal(v15Plan.status, "complete");
    assert.equal(await count("basalt_model_usage_ready"), 1);
  });
});

test("the tick moves to v16 once it is applied and backfills v16 to ready by ticks alone", async () => {
  await seriesFixture(async (f) => {
    const pool = String((await f.row()).pool);
    await disabled(f.db, () => f.insert(...rows(6, 3)));
    const stored = new Map<string, unknown>();
    const storage = {
      get: async <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
    };
    // A v15 backfill the tick finished before v16 was applied.
    const v15State: UsageRollupAutoState = {
      lastTickAt: "2026-01-31T00:00:00.000Z",
      lastStop: "ready",
    };
    await storage.put(usageRollupAutoKey, v15State);
    const ready = async () =>
      (await f.db.query("SELECT 1 FROM basalt_model_usage_people_ready WHERE pool=$1", [pool])).rows
        .length === 1;
    let clock = Date.parse("2026-02-01T00:00:00Z");
    let ticks = 0;
    for (; ticks < 100 && !(await ready()); ticks++) {
      await usageRollupTick(storage, (work) => work(f.db), {
        now: () => (clock += 1),
        bounds: { sessionMs: 3 },
      });
      clock += 300_000;
    }
    assert.ok(ticks > 1, `it took ${ticks} ticks`);
    assert.ok(await ready(), "ready on v16 by ticks alone");
    assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
    assert.deepEqual(stored.get(usageRollupAutoKey), v15State, "v15's state is kept apart");
    const state = await usageRollupAutoState(storage);
    assert.equal(state.rollup, "v16");
    assert.equal(usageRollupInspect(state).rollup, "v16", "the fleet lane sees v16");
    const after = await usageRollupTick(storage, (work) => work(f.db), { now: () => clock });
    assert.equal(after.lastStop, "ready");
    assert.equal((stored.get(usagePeopleRollupAutoKey) as UsageRollupAutoState).lastStop, "ready");
  });
});

test("a writer waits for a v16 recompute of its pool, and either rollup's recompute holds both triggers", async () => {
  await seriesFixture(async (f) => {
    const poolId = String((await f.row()).pool);
    await f.insert(...rows(2, 4));
    const other = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
    await other.connect();
    try {
      await other.query(`SET search_path TO ${f.schema}`);
      for (const recompute of [
        "basalt_model_usage_people_recompute",
        "basalt_model_usage_recompute",
      ]) {
        await other.query("BEGIN");
        await other.query(`SELECT ${recompute}($1,'2026-01-01T00:00:00Z','2026-01-01T02:00:00Z')`, [
          poolId,
        ]);
        let written = false;
        const writing = f
          .insert(...rows(1, 3, "2026-01-01T01:40:00Z"))
          .then(() => (written = true));
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(written, false, `the writer waits for ${recompute}`);
        await other.query("COMMIT");
        await writing;
      }
      assert.deepEqual((await f.db.query(people)).rows, (await f.db.query(raw)).rows);
      assert.deepEqual((await f.db.query(v15)).rows, (await f.db.query(v15Raw)).rows);
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      await other.end();
    }
  });
});
