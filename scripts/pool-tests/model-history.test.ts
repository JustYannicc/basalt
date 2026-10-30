import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { activateHomeBackfill, planHomeBackfill } from "../../src/pool/model-history/activation.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
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
    await db.query('INSERT INTO "user" VALUES (1,$1)', [await backendUserName("fixture-owner", "fixture-pool")]);
    await db.query("INSERT INTO api_key VALUES (1,$1,1)", [`sha256:${"a".repeat(64)}`]);
    const add = async (client: pg.Client, request: string, at = "2020-01-01T12:00:00.123456Z") => {
      await client.query(`INSERT INTO usage (timestamp,request_id,auth_index,provider,model,endpoint,api_key)
        VALUES ($1,$2,'fixture-account','fixture-provider','fixture-model','/v1/responses',$3)`,
      [at, request, `sha256:${"a".repeat(64)}`]);
    };
    await add(db, randomUUID());
    const before = await planHomeBackfill(db);
    assert.equal(before.rows, "1");
    assert.equal((await db.query("SELECT to_regclass('basalt_model_requests') AS relation")).rows[0].relation, null);
    await migrateModelHistory(db);
    await migrateModelHistory(db);
    assert.equal((await captureHomeRequests(db)).state, "inactive");
    assert.equal((await db.query("SELECT count(*)::text AS n FROM basalt_model_requests")).rows[0].n, "0");
    await activateHomeBackfill(db, before);
    const first = await captureHomeRequests(db);
    assert.equal(first.state, "active");
    assert.equal(first.state === "active" && first.backfillComplete, true);
    const pool = (await digest("fixture-pool")).slice(0, 16);
    const query = { pool, from: "2019-01-01T00:00:00Z", to: "2021-01-01T00:00:00Z" };
    const result = await readRequests(db, query);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.input_tokens, "100");
    assert.equal(result.records[0]!.reasoning_tokens, "3");
    assert.equal(result.records[0]!.cost, null);
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
  } finally {
    await late.query("ROLLBACK").catch(() => {});
    await late.end();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
});
