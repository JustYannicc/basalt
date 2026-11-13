import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { migrateAccountChanges } from "../../.upstream/apps/hosted/server/src/implementation/account-change-schema.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";

const fixture = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* makeExecutorStorage({ provider: "postgresql" })).migrate;
      for (const ddl of [
        'create table "user" (id text primary key, name text, "updatedAt" timestamptz)',
        'create table session (id text primary key, "userId" text, "expiresAt" timestamptz, "updatedAt" timestamptz)',
        'create table verification (id text primary key, identifier text, value text, "expiresAt" timestamptz, "updatedAt" timestamptz)',
        'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
        "create table organization (id text primary key, metadata text)",
        "create table hosted_app_account_links (app text, account text, subject text, requirement text)",
        "create table hosted_app_access (id text, organization_id text, audience text)",
        "create table hosted_account_access (account_id text, organization_id text, audience text)",
        "create table hosted_account_observation_access (account_id text, organization_id text, read_audience jsonb)",
        "create table hosted_account_rechecks (account_id text, organization_id text, outcome text, lease text, lease_until timestamptz)",
        "create table hosted_app_groups (app_id text, organization_id text, group_id text)",
        "create table hosted_account_groups (account_id text, organization_id text, group_id text)",
        "create table hosted_model_bindings (app_id text, pool_id text)",
        "create table hosted_groups (id text, organization_id text, name text)",
        "create table hosted_group_members (group_id text, member_id text)",
        "create table hosted_provisioning (organization_id text, status text, attempts int, updated_at timestamptz)",
        "create table hosted_organization_removal (organization_id text, status text)",
      ])
        yield* sql.unsafe(ddl);
      yield* sql`insert into executor_providers (id,definition) values ('prv_a','{}')`;
      yield* sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at)
      values ('acc_a','organization:team-a','prv_a','key','Retained',${new Uint8Array([1])},now())`;
      yield* sql`insert into executor_apps (id,code,owner,name,slug,created_at)
      values ('app_a','code_fixture','organization:team-a','Pool','pool',now())`;
      yield* sql`insert into organization values ('team-a','{}')`;
      yield* sql`insert into "user" values ('viewer-a','Viewer',now())`;
      yield* sql`insert into member values ('member-a','team-a','viewer-a','member')`;
      yield* sql`insert into session values ('session-a','viewer-a',now()+interval '1 hour',now())`;
      yield* migrateChangeRevisions;
      yield* migrateAccountChanges;
      return yield* work;
    }).pipe(Effect.provide(pgliteLayer())),
  );
const key = (topic: string) => ({ topic, resource: "*" });

test("migration 20 preserves saved accounts and repeated setup; real account, binding and observation writes move the head", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = makeChangeJournal(sql);
      const read = (topic = "accounts") =>
        journal
          .current("organization:team-a", [key(topic)])
          .pipe(Effect.map((heads) => heads[0]!.revision));
      yield* migrateAccountChanges;
      assert.equal(yield* read(), "0");
      assert.deepEqual(yield* sql`select label from executor_accounts`, [{ label: "Retained" }]);
      yield* sql`update executor_accounts set label='Renamed' where id='acc_a'`;
      assert.equal(yield* read(), "1");
      yield* sql`update executor_accounts set label='Renamed' where id='acc_a'`;
      assert.equal(yield* read(), "1");
      yield* sql`update executor_accounts set encrypted_credentials=${new Uint8Array([2])} where id='acc_a'`;
      assert.equal(yield* read(), "1", "token renewal does not change a visible account");
      yield* sql`update executor_accounts set credential_generation=credential_generation+1 where id='acc_a'`;
      assert.equal(yield* read(), "2");
      yield* sql`insert into hosted_app_account_links values ('app_a','acc_a',null,'models')`;
      assert.equal(yield* read(), "3");
      yield* sql`insert into executor_account_observations
      (id,account,owner,source,generation,data,next_allowed_at)
      values ('observation-a','acc_a','organization:team-a','quota',0,'{}',now())`;
      assert.equal(yield* read(), "4");
      yield* sql`update executor_account_observations set lease='collecting',lease_until=now()+interval '1 minute'`;
      assert.equal(yield* read(), "4", "collection leases do not invalidate a reading");
      yield* sql`update executor_account_observations set data='{"remaining":2}',checked_at=now()`;
      assert.equal(yield* read(), "5");
      const before = yield* read();
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`delete from hosted_app_account_links`;
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.result);
      assert.equal(yield* read(), before);
      yield* sql`delete from executor_accounts where id='acc_a'`;
      assert.equal(yield* read(), "6");
    }),
  ));

test("roles, groups, sharing, provisioning and session revocation have durable scoped hints", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = makeChangeJournal(sql);
      yield* sql`insert into hosted_groups values ('group-a','team-a','Group')`;
      yield* sql`insert into hosted_group_members values ('group-a','member-a')`;
      yield* sql`update member set role='admin' where id='member-a'`;
      yield* sql`insert into hosted_account_access values ('acc_a','team-a','everyone')`;
      yield* sql`insert into hosted_provisioning values ('team-a','queued',0,now())`;
      yield* sql`delete from session where id='session-a'`;
      const delivered: { scope: string; topic: string; revision: string }[] = [];
      yield* journal.deliver((scope, hint) =>
        Effect.sync(() => {
          delivered.push({ scope, ...hint });
        }),
      );
      assert.ok(
        delivered.some(
          (hint) => hint.scope === "organization:team-a" && hint.topic === "membership",
        ),
      );
      assert.ok(
        delivered.some((hint) => hint.scope === "organization:team-a" && hint.topic === "accounts"),
      );
      assert.ok(
        delivered.some((hint) => hint.scope === "organization:team-a" && hint.topic === "apps"),
      );
      assert.ok(
        delivered.some((hint) => hint.scope === "user:viewer-a" && hint.topic === "session"),
      );
      assert.equal(
        delivered.some((hint) => hint.scope === "organization:team-b"),
        false,
      );
      yield* journal.deliver(() => Effect.die("acknowledged hints cannot deliver twice"));
    }),
  ));
