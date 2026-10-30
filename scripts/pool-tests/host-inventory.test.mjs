import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { PgClient } from "@effect/sql-pg";
import { Console, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { reportHostPoolInventory } from "../../.upstream/apps/hosted/cloud/src/infrastructure/pool-inventory.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname) || new URL(adminUrl).pathname !== "/postgres") {
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");
}

test("the actual host job projects links and provenance in a read-only transaction", async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const records = [];
  const url = new URL(adminUrl);
  url.searchParams.set("options", "-c search_path=inventory_host_fixture,public");
  const run = () => Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* reportHostPoolInventory.pipe(Effect.provideService(GroupDatabase, Effect.succeed(sql)));
  }).pipe(
    Effect.provideService(Console.Console, { ...console, info: (line) => records.push(line) }),
    Effect.provide(PgClient.layer({ url: Redacted.make(url.toString()) })),
  ));
  let created = false;
  try {
    await admin.query("create schema inventory_host_fixture");
    created = true;
    await admin.query(`set search_path=inventory_host_fixture,public;
      create table executor_accounts (id text, owner text, provider text, method text, encrypted_credentials text);
      create table hosted_account_access (account_id text, organization_id text, creator_id text, personal_user_id text, kind text, audience text, revision text);
      create table hosted_account_groups (organization_id text, account_id text, group_id text);
      create table hosted_app_access (id text, organization_id text, creator_id text, audience text, revision text);
      create table hosted_app_groups (organization_id text, app_id text, group_id text);
      create table hosted_groups (id text, organization_id text, revision text);
      create table hosted_group_members (group_id text, member_id text);
      create table member (id text, "organizationId" text, "userId" text, role text);
      create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text);
      create table executor_account_connections (id text, owner text, provider text, reconnect_account text, revision text, state jsonb, target jsonb);
      create table hosted_connection_access (connection_id text, organization_id text, creator_id text, destination jsonb, target jsonb);
      create table executor_workflow_accounts (id text, account text, run text);
      create table executor_webhook_accounts (id text, account text, subscription text);
      create table executor_webhooks (id text, app text, owner text, source_account text, revision text);
      create table organization (id text, metadata text);
      insert into executor_accounts values ('account', 'person', 'provider', 'oauth', 'SYNTHETIC_ENCRYPTED_SECRET');
      insert into hosted_app_account_links values ('app', 'slot', null, 'account', 'person');
      insert into executor_account_connections values ('connection', 'person', 'provider', null, 'revision',
      '{"status":"completed","account":{"id":"account","secret":"SYNTHETIC_ACCOUNT_SECRET"},"interactive":{"app":"app","version":"version","ref":"auth-id","session":"SYNTHETIC_SESSION"}}',
      '{"app":"app","requirement":"slot","token":"SYNTHETIC_TARGET_SECRET"}');
      insert into hosted_connection_access values ('connection', 'org', 'person',
      '{"kind":"shared","audience":{"kind":"groups","groups":["group"]},"secret":"SYNTHETIC_DESTINATION_SECRET"}',
      '{"app":"app","requirement":"slot","scope":"app","name":"SYNTHETIC_APP_NAME"}');
      insert into organization values ('org', '{"executorKeyAccounts":{"person":"default-account"},"basaltPools":{"person":{"app":"app","version":"version","account":"account","bundle":"SYNTHETIC_BUNDLE"}},"secret":"SYNTHETIC_METADATA_SECRET"}')`);
    await run();
    const parts = records.map((line) => JSON.parse(line));
    const end = parts.pop();
    assert.equal(end.complete, true);
    assert.equal(end.migrationGo, false);
    const report = JSON.parse(parts.map((part) => part.data).join(""));
    assert.equal(report.sections.connections[0].acquisition_ref, "auth-id");
    assert.equal(report.sections.links[0].account, "account");
    assert.equal(report.sections.pools[0].app, "app");
    assert.equal(report.sections.defaults[0].account, "default-account");
    assert.equal(report.sections.connectionAccess[0].target_scope, "app");
    assert.equal(report.sections.connectionGroups[0].group_id, "group");
    assert.equal(records.join("").includes("SYNTHETIC"), false);

    records.length = 0;
    await admin.query(`alter table executor_accounts rename to stored_accounts;
      create table write_probe (id integer);
      create function inventory_write_probe() returns boolean language plpgsql as $$
      begin insert into write_probe values (1); return true; end $$;
      create view executor_accounts as select * from stored_accounts where inventory_write_probe()`);
    await run();
    assert.equal(records.length, 1);
    assert.equal(JSON.parse(records[0]).complete, false);
    assert.equal((await admin.query("select count(*)::int as count from write_probe")).rows[0].count, 0);
    assert.equal(records.join("").includes("SYNTHETIC"), false);
  } finally {
    if (created) await admin.query("drop schema inventory_host_fixture cascade");
    await admin.end();
  }
});
