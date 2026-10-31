import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { privacyReceipt } from "../../src/pool/privacy-receipt.ts";
import { poolInventorySnapshot, reportPoolInventory } from "../../src/pool/inventory.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname) || new URL(adminUrl).pathname !== "/postgres") {
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");
}

test("inventory distinguishes schema12 receipt states and cannot write through a SELECT", async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const url = new URL(adminUrl!);
  url.pathname = "/basalt_pool";
  const client = new pg.Client({ connectionString: url.toString() });
  let created = false;
  try {
    await admin.query("CREATE DATABASE basalt_pool");
    created = true;
    await client.connect();
    assert.equal((await client.query("select current_database() as name")).rows[0].name, "basalt_pool");
    await client.query(`create table home_data_migration (
      name text primary key, completed boolean not null, audit_marker_emitted boolean not null,
      usage_rows_updated bigint not null);
      create table home_data_migration_audit (name text primary key, rows_scanned bigint not null,
      active_api_key_count bigint not null, matched_active_api_key_copies bigint not null,
      deleted_api_key_count bigint not null, unknown_key_count bigint not null);
      create table auth (uuid text, id text, "index" text, provider text, disabled boolean, deleted_at timestamptz, auth_json jsonb);
      create table api_key (id bigint, user_id bigint, channels jsonb, deleted_at timestamptz, api_key text);
      create table channel_group (id bigint, disabled boolean, deleted_at timestamptz, channel_name text);
      create table channel_group_detail (id bigint, channel_group_id bigint, auth_id text, deleted_at timestamptz);
      insert into auth values ('auth-uuid', 'auth-id', 'auth-index', 'codex', false, null, '{"token":"SYNTHETIC_AUTH_SECRET"}');
      insert into api_key values (7, 9, '[11]', null, 'SYNTHETIC_KEY_SECRET');
      insert into channel_group values (11, false, null, 'signalbox-pool-app_fixture'),
        (12, false, null, 'SYNTHETIC_PRIVATE_CHANNEL_LABEL');
      insert into channel_group_detail values (13, 11, 'auth-id', null)`);
    assert.deepEqual(await privacyReceipt(client), { state: "missing_migration" });
    // Similar names must not satisfy this exact release's receipt selector.
    await client.query("insert into home_data_migration values ('diagnostics_metadata_only_v1_1_6-later', true, true, 99)");
    assert.deepEqual(await privacyReceipt(client), { state: "missing_migration" });
    await client.query("insert into home_data_migration values ('diagnostics_metadata_only_v1_1_6', false, false, 0)");
    assert.deepEqual(await privacyReceipt(client), {
      state: "missing_audit", completed: false, audit_marker_emitted: false, purged_rows: 0,
    });
    await client.query("insert into home_data_migration_audit values ('diagnostics_metadata_only_v1_1_6', 0, 0, 0, 0, 0)");
    assert.equal((await privacyReceipt(client)).state, "incomplete");
    await client.query("update home_data_migration set completed=true where name='diagnostics_metadata_only_v1_1_6'");
    assert.equal((await privacyReceipt(client)).state, "incomplete");
    await client.query("update home_data_migration set audit_marker_emitted=true where name='diagnostics_metadata_only_v1_1_6'");
    const receipt = await privacyReceipt(client);
    assert.deepEqual(receipt, { state: "complete", completed: true, audit_marker_emitted: true,
      usage_rows: 0, purged_rows: 0, active_key_count: 0, matched_active_key_copies: 0,
      deleted_key_count: 0, unknown_key_count: 0 });
    const report = await poolInventorySnapshot(client);
    assert.deepEqual(report.receipt, receipt);
    assert.equal(report.sections.credentials?.[0]?.uuid, "auth-uuid");
    assert.equal(report.sections.keys?.[0]?.id, "7");
    assert.equal(report.sections.channels?.[0]?.pool, "app_fixture");
    assert.equal(report.sections.channels?.[1]?.pool, null);
    assert.equal(JSON.stringify(report).includes("SYNTHETIC"), false);

    await client.query(`alter table auth rename to stored_auth;
      create table write_probe (id integer);
      create function inventory_write_probe() returns boolean language plpgsql as $$
      begin insert into write_probe values (1); return true; end $$;
      create view auth as select * from stored_auth where inventory_write_probe()`);
    await assert.rejects(poolInventorySnapshot(client), { code: "25006" });
    assert.equal((await client.query("select count(*)::int as count from write_probe")).rows[0].count, 0);
    await client.query("drop view auth; alter table stored_auth rename to auth");
    await client.query("alter table home_data_migration_audit drop column unknown_key_count");
    await assert.rejects(poolInventorySnapshot(client), { code: "42703" });
    // Failure rolls back the read-only transaction instead of leaving a poisoned connection.
    assert.equal((await client.query("select current_setting('transaction_read_only') as setting")).rows[0].setting, "off");
  } finally {
    await client.end();
    if (created) await admin.query("DROP DATABASE basalt_pool");
    await admin.end();
  }
});

test("connection failures publish only a closed private failure record", async () => {
  const records: string[] = [];
  const original = console.info;
  console.info = (line: string) => records.push(line);
  try {
    await reportPoolInventory({ connectionString: "postgres://SYNTHETIC_LOGIN:SYNTHETIC_SECRET@localhost:1/wrong_database" });
  } finally {
    console.info = original;
  }
  assert.equal(records.length, 1);
  const record = JSON.parse(records[0]!);
  assert.equal(record.complete, false);
  assert.equal(record.reason, "query_failed");
  assert.equal(record.migrationGo, false);
  assert.equal(records.join("").includes("SYNTHETIC"), false);
});
