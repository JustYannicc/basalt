import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { backendUserName, digest } from "./backend-users.ts";
import { poolGroupPrefix } from "./pool-group.ts";
import { captureHomeRequests } from "./model-history/capture.ts";
import { historyChangeStatements } from "./model-history/change-schema.ts";
import {
  deliverPoolHistoryChanges,
  readPoolHistoryChanges,
  readPoolHistorySnapshot,
  type PoolHistoryChange,
} from "./model-history/change-revisions.ts";
import { migrateModelHistory, type HistoryDatabase } from "./model-history/schema.ts";

const pool = "app_0123456789abcdef",
  other = "app_fedcba9876543210";

async function fixture() {
  const sql = new PGlite();
  const queries: string[] = [];
  const db: HistoryDatabase = {
    query: async (text, values) => {
      queries.push(text);
      const result = await sql.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  await sql.exec(`CREATE ROLE basalt_pool_owner NOLOGIN;
    ALTER SCHEMA public OWNER TO basalt_pool_owner; SET ROLE basalt_pool_owner;
    CREATE TABLE channel_group(id bigint PRIMARY KEY,channel_name text,disabled boolean DEFAULT false,
      deleted_at timestamptz,updated_at timestamptz,usage_credit_policy text,account_selection_policy text);
    CREATE TABLE channel_group_detail(id bigint PRIMARY KEY,channel_group_id bigint,auth_id text,
      deleted_at timestamptz,updated_at timestamptz);
    CREATE INDEX ON channel_group_detail(auth_id,deleted_at,channel_group_id);
    CREATE TABLE auth(uuid text PRIMARY KEY,id text,"index" text,provider text,label text,
      disabled boolean,deleted_at timestamptz,auth_json jsonb,version bigint,updated_at timestamptz);
    CREATE TABLE quota_snapshot(credential_id text PRIMARY KEY,quota_status text,collection_status text,
      reset_credits jsonb,usage_credits jsonb,observed_at timestamptz,expires_at timestamptz,
      probe_lease_owner text,probe_lease_expires_at timestamptz,updated_at timestamptz);
    CREATE TABLE quota_window(credential_id text,window_id text,remaining numeric,reset_at timestamptz,expires_at timestamptz,
      observed_at timestamptz,updated_at timestamptz,PRIMARY KEY(credential_id,window_id));
    CREATE TABLE credential_concurrency_policies(credential_id text PRIMARY KEY,max_in_flight bigint,
      version bigint,observation_barrier_revision bigint,updated_at timestamptz);
    CREATE TABLE credential_concurrency_model_policies(credential_id text,model text,max_in_flight bigint);
    CREATE TABLE "user"(id bigint PRIMARY KEY,username text,limit_7d_credits numeric,
      usage_epoch_7d timestamptz,updated_at timestamptz,deleted_at timestamptz,
      timezone text,window_mode_7d text,week_reset_day int,week_reset_hour int);
    CREATE TABLE api_key(id bigint PRIMARY KEY,user_id bigint,channels jsonb,display_name text,deleted_at timestamptz);
    CREATE TABLE billing_charge(id text PRIMARY KEY,user_id bigint,amount numeric,usage_id bigint);
    CREATE TABLE billing_model_price(id text PRIMARY KEY,model text,input_price_per_million numeric,
      enabled boolean,revision bigint,updated_at timestamptz);
    CREATE TABLE config(key text PRIMARY KEY,value jsonb,version bigint,updated_at timestamptz);
    CREATE TABLE kv_store(key text PRIMARY KEY,value bytea,version bigint);
    CREATE TABLE model_group(id bigint PRIMARY KEY,group_name text,disabled boolean);
    CREATE TABLE model_group_detail(id bigint PRIMARY KEY,model_group_id bigint,model_id text,channels jsonb);
    CREATE TABLE lifecycle_config(id bigint PRIMARY KEY,payload jsonb,revision bigint,updated_at timestamptz);
    CREATE TABLE cpa_node(id bigint PRIMARY KEY,last_seen_at timestamptz);`);
  await migrateModelHistory(db);
  await db.query("INSERT INTO channel_group(id,channel_name) VALUES(1,$1),(2,$2)", [
    `${poolGroupPrefix}${pool}`,
    `${poolGroupPrefix}${other}`,
  ]);
  await db.query(
    "INSERT INTO channel_group_detail(id,channel_group_id,auth_id) VALUES(1,1,'account')",
  );
  await db.query('INSERT INTO "user"(id,username) VALUES(1,$1)', [
    await backendUserName("person", pool),
  ]);
  await db.query("DELETE FROM basalt_pool_change_pending");
  const revision = async (id = pool, topic = "pool-readings") =>
    (await readPoolHistoryChanges(db, id)).find((hint) => hint.topic === topic)!.revision;
  return { sql, db, queries, revision };
}

test("committed changes map history and users to actual app IDs, roll back together and migrate twice", async () => {
  const f = await fixture();
  try {
    const targets = [
      "api_key",
      "auth",
      "basalt_model_requests",
      "basalt_model_traffic",
      "billing_charge",
      "billing_model_price",
      "channel_group",
      "channel_group_detail",
      "config",
      "credential_concurrency_model_policies",
      "credential_concurrency_policies",
      "kv_store",
      "lifecycle_config",
      "model_group",
      "model_group_detail",
      "quota_snapshot",
      "quota_window",
      "user",
    ].sort();
    const coverage = await f.db.query(
      `SELECT c.relname AS name,
      bool_or(t.tgname='basalt_pool_change_write') AS write_registered,
      bool_or(t.tgname='basalt_pool_change_delete') AS delete_registered
      FROM pg_class c JOIN pg_trigger t ON t.tgrelid=c.oid
      WHERE c.relname=ANY($1::text[]) AND NOT t.tgisinternal GROUP BY c.relname ORDER BY c.relname`,
      [targets],
    );
    assert.deepEqual(
      coverage.rows,
      targets.map((name) => ({ name, write_registered: true, delete_registered: true })),
    );
    assert.equal(await f.revision(pool, "pool-usage"), "0");
    assert.deepEqual(await readPoolHistoryChanges(f.db, "app_" + "a".repeat(16)), [
      { topic: "pool-readings", resource: "app_" + "a".repeat(16), revision: "0" },
      { topic: "pool-usage", resource: "app_" + "a".repeat(16), revision: "0" },
    ]);
    const before = await f.revision();
    await f.db.query("BEGIN");
    await f.db.query('UPDATE "user" SET limit_7d_credits=25 WHERE id=1');
    assert.ok(BigInt(await f.revision()) > BigInt(before));
    await f.db.query("ROLLBACK");
    assert.equal(await f.revision(), before);
    assert.equal((await f.db.query("SELECT * FROM basalt_pool_change_pending")).rows.length, 0);
    await f.db.query('UPDATE "user" SET limit_7d_credits=25 WHERE id=1');
    assert.ok(BigInt(await f.revision()) > BigInt(before));
    const hash = (await digest(pool)).slice(0, 16);
    assert.notEqual(hash, pool);
    await f.db.query(
      `INSERT INTO basalt_model_requests(id,source,source_record,timestamp,timestamp_exact,
      pool,token_quality,failed,cost_basis,attribution) VALUES($1,$2,$3,now(),'2026-11-13T00:00:00Z',
      $4,'unclassified',false,'unpriced','unknown')`,
      ["a".repeat(64), "b".repeat(64), "c".repeat(64), hash],
    );
    assert.equal(await f.revision(pool, "pool-usage"), "1");
    assert.equal(await f.revision(other, "pool-usage"), "0");
    const reading = await f.revision();
    await f.db.query(`INSERT INTO basalt_model_requests SELECT * FROM basalt_model_requests
      ON CONFLICT(id) DO NOTHING`);
    assert.equal(await f.revision(pool, "pool-usage"), "1");
    await f.db.query(
      `INSERT INTO basalt_model_traffic(pool,source,client_key,purpose,evidence)
      VALUES($1,$2,$3,'proof',$4)`,
      [hash, "b".repeat(64), "d".repeat(64), "e".repeat(64)],
    );
    assert.equal(await f.revision(pool, "pool-usage"), "2");
    await f.db.query("UPDATE basalt_model_traffic SET changed_at=now()");
    assert.equal(await f.revision(pool, "pool-usage"), "2");
    assert.equal(await f.revision(), reading);
    for (const statement of historyChangeStatements) await f.db.query(statement);
    await migrateModelHistory(f.db);
    assert.equal(await f.revision(pool, "pool-usage"), "2");
    assert.equal(await f.revision(), reading);
  } finally {
    await f.sql.close();
  }
});

test("authorized zero registration maps later hashed writes without a group and inherits runtime grants", async () => {
  const f = await fixture();
  try {
    const app = "app_uninitialized-pool";
    await f.sql.exec(`RESET ROLE; CREATE ROLE change_fixture_runtime NOLOGIN;
      GRANT basalt_pool_owner TO change_fixture_runtime WITH INHERIT TRUE, SET TRUE;
      SET ROLE change_fixture_runtime;`);
    assert.deepEqual(await readPoolHistoryChanges(f.db, app), [
      { topic: "pool-readings", resource: app, revision: "0" },
      { topic: "pool-usage", resource: app, revision: "0" },
    ]);
    assert.equal((await f.db.query("SELECT * FROM basalt_pool_change_pending")).rows.length, 0);
    const writer: HistoryDatabase = { query: (text, values) => f.db.query(text, values) };
    const hash = (await digest(app)).slice(0, 16);
    assert.notEqual(hash, app);
    await writer.query(
      `INSERT INTO basalt_model_traffic(pool,source,client_key,purpose,evidence)
      VALUES($1,$2,$3,'real',$4)`,
      [hash, "b".repeat(64), "c".repeat(64), "d".repeat(64)],
    );
    const result = await captureHomeRequests(f.db);
    assert.deepEqual(result.pending, [
      { scope: `pool:${app}`, hint: { topic: "pool-usage", resource: app, revision: "1" } },
    ]);
    await deliverPoolHistoryChanges(f.db, result.pending, async () => {});
    assert.deepEqual((await captureHomeRequests(f.db)).pending, []);
    assert.equal((await readPoolHistoryChanges(f.db, app))[1]!.revision, "1");
    await assert.rejects(readPoolHistoryChanges(f.db, "a".repeat(16)));
    await assert.rejects(readPoolHistoryChanges(f.db, "app_" + "a".repeat(253)));
  } finally {
    await f.sql.close();
  }
});

test("current snapshot returns a future semantic deadline without rewriting observations", async () => {
  const f = await fixture();
  try {
    await f.db
      .query(`INSERT INTO quota_snapshot(credential_id,observed_at,expires_at,reset_credits,usage_credits)
      VALUES('account','2026-11-13T00:00:00.123456Z','2099-01-01T01:00:00Z',
        '{"credits":[{"status":"available","expires_at":"2099-01-01T00:15:00.123456Z"}]}',
        '{"state":"available","expires_at":"2099-01-01T00:10:00.123456Z"}')`);
    await f.db.query(`INSERT INTO quota_window(credential_id,window_id,reset_at,expires_at)
      VALUES('account','weekly','2099-01-01T00:30:00.123456Z','2099-01-01T00:45:00Z')`);
    const retained = (
      await f.db.query(
        "SELECT observed_at::text,expires_at::text,reset_credits,usage_credits FROM quota_snapshot",
      )
    ).rows;
    const first = await readPoolHistorySnapshot(f.db, pool);
    assert.equal(first.deadline, "2099-01-01T00:10:00.123456Z");
    await f.db.query("UPDATE quota_snapshot SET usage_credits=NULL");
    assert.equal(
      (await readPoolHistorySnapshot(f.db, pool)).deadline,
      "2099-01-01T00:15:00.123456Z",
    );
    await f.db.query("UPDATE quota_snapshot SET reset_credits=NULL");
    assert.equal(
      (await readPoolHistorySnapshot(f.db, pool)).deadline,
      "2099-01-01T00:30:00.123456Z",
    );
    await f.db.query(
      "UPDATE \"user\" SET limit_7d_credits=25,window_mode_7d='calendar',timezone='UTC',week_reset_day=1,week_reset_hour=0",
    );
    const capped = await readPoolHistorySnapshot(f.db, pool);
    const deadline = new Date(capped.deadline!);
    assert.equal(deadline.getUTCDay(), 1);
    assert.equal(deadline.getUTCHours(), 0);
    assert.equal(deadline.getUTCMinutes(), 0);
    const now = Date.parse(
      (await f.db.query("SELECT statement_timestamp()::text AS now")).rows[0]!.now as string,
    );
    assert.ok(deadline.getTime() > now && deadline.getTime() - now <= 7 * 86_400_000);
    const after = (
      await f.db.query("SELECT observed_at::text,expires_at::text FROM quota_snapshot")
    ).rows[0]!;
    assert.equal(after.observed_at, retained[0]!.observed_at);
    assert.equal(after.expires_at, retained[0]!.expires_at);
    assert.equal((await readPoolHistorySnapshot(f.db, "app_no-members")).deadline, null);
  } finally {
    await f.sql.close();
  }
});

test("Home readings cover selected credentials, resets, limits, memberships, catalog and deletion without upkeep noise", async () => {
  const f = await fixture();
  const changed = async (query: string, id = pool) => {
    const before = await f.revision(id);
    await f.db.query(query);
    assert.ok(BigInt(await f.revision(id)) > BigInt(before), query);
  };
  const unchanged = async (query: string) => {
    const before = await f.revision();
    await f.db.query(query);
    assert.equal(await f.revision(), before, query);
  };
  try {
    await changed(`INSERT INTO auth(uuid,id,"index",provider,auth_json)
      VALUES('account','account','account','codex','{"metadata":{"access_token":"synthetic"},"model_states":{"m":{"status":"ready","updated_at":"old"}}}')`);
    await unchanged(`UPDATE auth SET version=2,updated_at=now(),auth_json=jsonb_set(
      jsonb_set(auth_json,'{metadata,access_token}','"synthetic-rotated"'),'{model_states,m,updated_at}','"new"')`);
    await changed("UPDATE auth SET disabled=true");
    await changed(
      `UPDATE auth SET auth_json=jsonb_set(auth_json,'{model_states,m,status}','"error"')`,
    );
    await changed(
      "INSERT INTO quota_snapshot(credential_id,quota_status) VALUES('account','healthy')",
    );
    await unchanged(
      "UPDATE quota_snapshot SET probe_lease_owner='lease',probe_lease_expires_at=now(),updated_at=now()",
    );
    await changed(
      `UPDATE quota_snapshot SET reset_credits='{"available_count":2}',usage_credits='{"state":"enabled"}'`,
    );
    await changed("UPDATE quota_snapshot SET observed_at=now(),expires_at=now()+interval '1 hour'");
    await changed(
      "INSERT INTO quota_window(credential_id,window_id,remaining) VALUES('account','weekly',25)",
    );
    await unchanged("UPDATE quota_window SET updated_at=now()");
    await changed("UPDATE quota_window SET remaining=24,reset_at=now()+interval '7 days'");
    await changed(
      "INSERT INTO credential_concurrency_policies(credential_id,max_in_flight) VALUES('account',3)",
    );
    await unchanged(
      "UPDATE credential_concurrency_policies SET version=2,observation_barrier_revision=9,updated_at=now()",
    );
    await changed("INSERT INTO credential_concurrency_model_policies VALUES('account','m',1)");
    await changed("INSERT INTO api_key(id,user_id,channels) VALUES(1,1,'[1]')");
    await changed("INSERT INTO billing_charge(id,user_id,amount) VALUES('charge',1,2)");
    await unchanged("INSERT INTO cpa_node VALUES(1,now())");
    await unchanged("UPDATE channel_group SET updated_at=now()");
    await unchanged("INSERT INTO kv_store VALUES('unrelated',decode('01','hex'),1)");
    await changed(
      `INSERT INTO kv_store VALUES('billing.settings',convert_to('{"enabled":true,"timezone":"UTC"}','UTF8'),1)`,
    );
    await unchanged(`UPDATE kv_store SET value=convert_to('{"timezone":"UTC", "enabled":true}','UTF8'),version=2
      WHERE key='billing.settings'`);
    const otherBefore = await f.revision(other);
    await changed(
      `INSERT INTO billing_model_price(id,model,input_price_per_million,enabled) VALUES('price','m',2,true)`,
    );
    assert.ok(BigInt(await f.revision(other)) > BigInt(otherBefore));
    await unchanged("UPDATE billing_model_price SET revision=2,updated_at=now()");
    await changed("INSERT INTO config(key,value) VALUES('oauth-excluded-models','{}')");
    await unchanged("UPDATE config SET value='{}',version=2,updated_at=now()");
    await changed("UPDATE channel_group_detail SET channel_group_id=2 WHERE id=1", other);
    const removed = await f.revision();
    await changed("DELETE FROM auth WHERE uuid='account'", other);
    assert.equal(await f.revision(), removed);
    await changed("DELETE FROM channel_group_detail WHERE id=1", other);
    await changed("DELETE FROM channel_group WHERE id=2", other);
    await f.db.query(
      `INSERT INTO basalt_model_traffic(pool,source,client_key,purpose,evidence)
      VALUES($1,$2,$3,'real',$4)`,
      [(await digest(other)).slice(0, 16), "b".repeat(64), "c".repeat(64), "d".repeat(64)],
    );
    assert.equal(await f.revision(other, "pool-usage"), "1");
    assert.equal(await f.revision(pool, "pool-usage"), "0");
  } finally {
    await f.sql.close();
  }
});

test("inactive capture piggybacks pending delivery, keeps failed and newer revisions, and adds no idle statement", async () => {
  const f = await fixture();
  try {
    f.queries.length = 0;
    const idle = await captureHomeRequests(f.db);
    assert.equal(idle.state, "inactive");
    assert.deepEqual(idle.pending, []);
    assert.equal(f.queries.length, 5);
    await deliverPoolHistoryChanges(f.db, idle.pending, async () => assert.fail("No idle publish"));
    assert.equal(f.queries.length, 5);
    await f.db.query("UPDATE channel_group SET disabled=true WHERE id=1");
    const captured = await captureHomeRequests(f.db);
    const event = captured.pending[0]!;
    assert.deepEqual(event, {
      scope: `pool:${pool}`,
      hint: {
        topic: "pool-readings",
        resource: pool,
        revision: await f.revision(),
      },
    });
    await assert.rejects(
      deliverPoolHistoryChanges(f.db, captured.pending, async () => {
        throw new Error("offline");
      }),
    );
    assert.equal((await captureHomeRequests(f.db)).pending.length, 1);
    const sent: PoolHistoryChange[] = [];
    await deliverPoolHistoryChanges(f.db, captured.pending, async (changes) => {
      sent.push(...changes);
      assert.equal(f.queries.at(-1), "COMMIT");
      await f.db.query("UPDATE channel_group SET disabled=false WHERE id=1");
    });
    const retry = await captureHomeRequests(f.db);
    assert.equal(retry.pending.length, 1);
    assert.ok(BigInt(retry.pending[0]!.hint.revision) > BigInt(event.hint.revision));
    await deliverPoolHistoryChanges(f.db, retry.pending, async (changes) => {
      sent.push(...changes);
    });
    assert.equal((await captureHomeRequests(f.db)).pending.length, 0);
    assert.equal(sent.length, 2);
    assert.ok(
      f.queries.some((query) => query.startsWith("DELETE FROM basalt_pool_change_pending")),
    );
  } finally {
    await f.sql.close();
  }
});
