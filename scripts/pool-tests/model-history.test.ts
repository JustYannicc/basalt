import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { activateHomeBackfill, planHomeBackfill } from "../../src/pool/model-history/activation.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { historyObject } from "../../src/pool/model-history/record.ts";
import { readRequests } from "../../src/pool/model-history/store.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");

test("request history backfills explicitly, survives restarts and late commits, and cannot be expired", async () => {
  const schema = `history_${randomUUID().replaceAll("-", "")}`;
  const db = new pg.Client({ connectionString: adminUrl });
  const late = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  await late.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await late.query(`SET search_path TO ${schema}`);
    // Synthetic Home metadata columns only. No fixture prompts, auth blobs or raw keys exist.
    await db.query(`CREATE TABLE usage (
      id bigserial PRIMARY KEY,timestamp timestamptz NOT NULL,request_id text,auth_index text,provider text,
      model text,endpoint text,event_type text,service_tier text,
      input_tokens bigint DEFAULT 100,output_tokens bigint DEFAULT 10,reasoning_tokens bigint DEFAULT 3,
      cached_tokens bigint DEFAULT 20,cache_read_tokens bigint DEFAULT 20,cache_read_tokens_present boolean DEFAULT true,
      cache_creation_tokens bigint DEFAULT 0,total_tokens bigint DEFAULT 110,token_accounting_quality text DEFAULT 'complete',
      token_accounting_version int DEFAULT 2,accounting_input_tokens bigint DEFAULT 100,accounting_output_tokens bigint DEFAULT 10,
      accounting_cache_read_tokens bigint DEFAULT 20,accounting_cache_write_tokens bigint DEFAULT 0,
      accounting_reasoning_tokens bigint DEFAULT 3,accounting_total_tokens bigint DEFAULT 110,
      latency_ms bigint DEFAULT 100,failed boolean DEFAULT false,fail_status_code int DEFAULT 0,
      upstream_status_code int DEFAULT 200,api_key text)`);
    await db.query(`CREATE TABLE billing_charge (id text,usage_id bigint,amount numeric,matched_price_rule text,
      price_snapshot jsonb,api_key_id bigint,user_id bigint)`);
    await db.query("CREATE TABLE api_key (id bigint,diagnostic_fingerprint text,user_id bigint)");
    await db.query('CREATE TABLE "user" (id bigint,username text)');
    await db.query("CREATE TABLE home_data_migration (name text PRIMARY KEY,completed boolean NOT NULL)");
    await db.query("INSERT INTO home_data_migration VALUES ('diagnostics_metadata_only_v1_1_6',false)");
    await db.query('INSERT INTO "user" VALUES (1,$1)', [await backendUserName("fixture-owner", "fixture-pool")]);
    await db.query("INSERT INTO api_key VALUES (1,$1,1)", [`sha256:${"a".repeat(64)}`]);
    const add = async (client: pg.Client, request: string, at = "2020-01-01T12:00:00.123456Z") => {
      await client.query(`INSERT INTO usage (timestamp,request_id,auth_index,provider,model,endpoint,api_key)
        VALUES ($1,$2,'fixture-account','fixture-provider','fixture-model','/v1/responses',$3)`,
      [at, request, `sha256:${"a".repeat(64)}`]);
    };
    await add(db, randomUUID());
    await db.query("UPDATE usage SET model=NULL WHERE id=1");
    await db.query(`INSERT INTO billing_charge (id,usage_id,amount,matched_price_rule,price_snapshot,api_key_id,user_id)
      VALUES ('fixture-charge',1,0.000123456789012345678,'fixture-price',
        '{"input_price_per_million":2,"output_price_per_million":8,"cache_read_price_per_million":0.5,"cache_write_price_per_million":2.5,"request_price":0,"matched_service_tier":"*","min_input_tokens":0,"provider":"fixture-provider","model":"fixture-priced-model","requested_service_tier":"priority","response_service_tier":"flex","service_tier_source":"response","effective_service_tier":"flex","response_tier_fallback":false}',1,1)`);
    const before = await planHomeBackfill(db);
    assert.equal(before.rows, "1");
    assert.equal((await db.query("SELECT to_regclass('basalt_model_requests') AS relation")).rows[0].relation, null);
    await migrateModelHistory(db);
    await migrateModelHistory(db);
    assert.equal((await captureHomeRequests(db)).state, "inactive");
    assert.equal((await db.query("SELECT count(*)::text AS n FROM basalt_model_requests")).rows[0].n, "0");
    assert.equal(before.privacyReady, false);
    await assert.rejects(activateHomeBackfill(db, before));
    await db.query("UPDATE home_data_migration SET completed=true");
    const approved = await planHomeBackfill(db);
    assert.equal(approved.privacyReady, true);
    await db.query("UPDATE home_data_migration SET completed=false");
    await assert.rejects(activateHomeBackfill(db, approved));
    assert.equal((await db.query("SELECT count(*)::text AS n FROM basalt_model_history_cursor")).rows[0].n, "0");
    await db.query("UPDATE home_data_migration SET completed=true");
    await activateHomeBackfill(db, approved);
    const first = await captureHomeRequests(db);
    assert.equal(first.state, "active");
    assert.equal(first.state === "active" && first.backfillComplete, true);
    const pool = (await digest("fixture-pool")).slice(0, 16);
    const query = { pool, from: "2019-01-01T00:00:00Z", to: "2021-01-01T00:00:00Z" };
    const result = await readRequests(db, query);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.input_tokens, "100");
    assert.equal(result.records[0]!.reasoning_tokens, "3");
    assert.equal(result.records[0]!.model, null);
    assert.equal(result.records[0]!.cost, "0.000123456789012");
    assert.deepEqual(historyObject(result.records[0]!.price_snapshot).billing, {
      matchedRule: "fixture-price", provider: "fixture-provider", model: "fixture-priced-model",
      requestedTier: "priority", responseTier: "flex", tierSource: "response", effectiveTier: "flex", responseFallback: false,
    });
    assert.equal((await readRequests(db, { ...query, person: await digest("other-member") })).records.length, 0);

    await late.query("BEGIN");
    await add(late, randomUUID());
    await add(db, randomUUID());
    await captureHomeRequests(db);
    await late.query("COMMIT");
    // Another connection models the next process; only the database cursor carries progress.
    await captureHomeRequests(late);
    assert.equal((await db.query("SELECT count(*)::text AS n FROM basalt_model_requests")).rows[0].n, "3");
    await db.query('INSERT INTO "user" VALUES (2,$1)', [await backendUserName("fixture-other", "other-pool")]);
    await db.query("UPDATE api_key SET user_id=2");
    await captureHomeRequests(late);
    assert.equal((await readRequests(db, query)).records.length, 3, "a moved key cannot rewrite old attribution or poison the sweep");
    await captureHomeRequests(late);
    assert.equal((await db.query("SELECT count(*)::text AS n FROM basalt_model_requests")).rows[0].n, "3");
    await assert.rejects(db.query("DELETE FROM basalt_model_requests"), { code: "55000" });
    await assert.rejects(db.query("UPDATE basalt_model_requests SET cost=0"), { code: "55000" });
    await assert.rejects(db.query("TRUNCATE basalt_model_requests"), { code: "55000" });
    await assert.rejects(db.query("TRUNCATE basalt_model_requests_0"), { code: "55000" });
    await migrateModelHistory(db);
    assert.equal((await db.query("SELECT count(*)::text AS n FROM basalt_model_requests")).rows[0].n, "3");
    await db.query("UPDATE api_key SET user_id=1");
    const sharedTrace = randomUUID();
    await add(db, sharedTrace);
    await add(db, sharedTrace);
    await db.query(`UPDATE usage SET failed=true,fail_status_code=429 WHERE id=5`);
    await db.query(`INSERT INTO billing_charge (id,usage_id,amount,matched_price_rule,price_snapshot,api_key_id,user_id)
      SELECT 'retry-first-charge',4,amount,matched_price_rule,price_snapshot,1,1 FROM billing_charge WHERE usage_id=1`);
    await db.query(`INSERT INTO billing_charge (id,usage_id,amount,matched_price_rule,price_snapshot,api_key_id,user_id)
      SELECT 'second-charge',5,amount,'fixture-other-rule',price_snapshot ||
        '{"response_service_tier":"priority","effective_service_tier":"priority","response_tier_fallback":true}'::jsonb,1,1
      FROM billing_charge WHERE usage_id=1`);
    await captureHomeRequests(db);
    const attempts = (await db.query("SELECT id,price_version,failed FROM basalt_model_requests WHERE request_id=$1", [sharedTrace])).rows;
    assert.equal(attempts.length, 2, "shared HTTP traces cannot collapse distinct usage IDs");
    assert.equal(new Set(attempts.map((row) => row.id)).size, 2);
    assert.equal(new Set(attempts.map((row) => row.price_version)).size, 2, "billing rule and effective tier are part of price identity");
    assert.equal(attempts.filter((row) => row.failed === true).length, 1);
    const delayedRequest = randomUUID();
    await late.query("BEGIN");
    await add(late, delayedRequest);
    for (let cycle = 0; cycle < 4; cycle++) {
      await db.query(`INSERT INTO usage (timestamp,request_id,auth_index,provider,model,endpoint,api_key)
        SELECT '2020-01-01T12:00:00Z'::timestamptz,'sweep-fixture-' || $1::text || '-' || n,
          'fixture-account','fixture-provider','fixture-model','/v1/responses',$2 FROM generate_series(1,400) n`,
      [cycle, `sha256:${"a".repeat(64)}`]);
      await captureHomeRequests(db);
      if (cycle === 0) await late.query("COMMIT");
    }
    assert.equal((await db.query("SELECT count(*)::text AS n FROM basalt_model_requests WHERE request_id=$1", [delayedRequest])).rows[0].n, "1",
      "a fixed sweep horizon wraps despite sustained traffic above its page rate");
  } finally {
    await late.query("ROLLBACK").catch(() => {});
    await late.end();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
});
