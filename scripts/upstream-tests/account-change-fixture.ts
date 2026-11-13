import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { migrateAccountChanges } from "../../.upstream/apps/hosted/server/src/implementation/account-change-schema.ts";
import { migrateChangeRevisions } from "../../.upstream/apps/hosted/server/src/implementation/change-revision-schema.ts";

export const fixture = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
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
export const key = (topic: string) => ({ topic, resource: "*" });
