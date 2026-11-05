import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { createRequire } from "node:module";

const sdkRequire = createRequire(
  new URL("../.upstream/packages/sdk/package.json", import.meta.url),
);
const { pgliteLayer }: typeof import("../.upstream/packages/fumadb-effect/src/pglite.ts") =
  sdkRequire("fumadb-effect/pglite");
import { makeAccountRecheckQueue } from "../.upstream/apps/hosted/server/src/implementation/account-recheck-queue.ts";
import { migrateAccountRechecks } from "../.upstream/apps/hosted/server/src/implementation/account-recheck-schema.ts";

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const statements = `
    create table organization(id text primary key);
    create table member(id text, "organizationId" text, "userId" text, role text);
    create table executor_providers(id text primary key, definition jsonb);
    create table executor_accounts(id text primary key, owner text, provider text, method text,
      credential_generation int, label text default '', description text, encrypted_credentials text default 'keep-me');
    create table hosted_account_access(account_id text primary key, organization_id text, kind text, personal_user_id text, audience text default 'everyone');
    create table hosted_account_groups(account_id text, group_id text);
    create table executor_apps(id text primary key, owner text, active_deployment text);
    create table executor_deployments(id text primary key, requirements jsonb);
    create table hosted_app_account_links(app text, requirement text, account text, subject text, linked_by text, created_at timestamptz default now());
    create table hosted_app_access(id text, organization_id text, audience text, creator_id text);
    create table hosted_app_groups(app_id text, group_id text);
    create table hosted_group_members(group_id text, member_id text);
    create table executor_account_checks(account text, app text, deployment text, credential_generation int,
      checked_at timestamptz, status text, account_info jsonb, unique(account,app));
    create table executor_account_acquisitions(account text, owner text, provider text, method text,
      generation int, removal jsonb, driver_revision text, revision text);
    create table executor_account_driver_checks(account text, checkable boolean, driver_revision text,
      binding_revision text, generation int, checked_at timestamptz);
    create table hosted_organization_removal(organization_id text);
    insert into organization values ('org');
    insert into member values ('member', 'org', 'owner', 'owner');
  `
    .split(";")
    .filter((statement) => statement.trim());
  for (const statement of statements) yield* sql.unsafe(statement);
  yield* migrateAccountRechecks;
  yield* migrateAccountRechecks;
  const add = (id: string, family = id, version = "v2", generation = 2) =>
    Effect.gen(function* () {
      const provider = `prv_${id}`;
      id = `acc_${id}`;
      const app = `app_${id}`;
      yield* sql`insert into executor_providers values (${provider}, ${JSON.stringify({ family: { id: family } })}::jsonb)`;
      yield* sql`insert into executor_accounts(id,owner,provider,method,credential_generation)
      values (${id}, 'organization:org', ${provider}, 'token', ${generation})`;
      yield* sql`insert into hosted_account_access(account_id,organization_id,kind,personal_user_id) values (${id}, 'org', 'personal', 'owner')`;
      yield* sql`insert into executor_apps values (${app}, 'organization:org', ${version})`;
      yield* sql`insert into executor_deployments values (${version}, ${JSON.stringify({ accounts: { service: { provider, health: true } } })}::jsonb)
      on conflict(id) do update set requirements = excluded.requirements`;
      // Each app has its own version so the provider declaration stays independent.
      yield* sql`update executor_deployments set id = ${`${app}-${version}`} where id = ${version}`;
      yield* sql`update executor_apps set active_deployment = ${`${app}-${version}`} where id = ${app}`;
      yield* sql`insert into hosted_app_account_links(app,requirement,account,subject,linked_by) values (${app}, 'service', ${id}, null, 'owner')`;
      return { account: id, app, version: `${app}-${version}`, provider };
    });
  const checked = (
    item: { account: string; app: string; version: string },
    version = item.version,
    generation = 2,
    ageHours = 0,
  ) =>
    sql`insert into executor_account_checks(account, app, deployment, credential_generation, checked_at, status)
      values (${item.account}, ${item.app}, ${version}, ${generation}, now() - ${ageHours} * interval '1 hour', 'healthy')`;
  return { sql, add, checked, queue: makeAccountRecheckQueue(sql) };
});
export const runRecheckFixture = <E>(
  body: (f: Effect.Success<typeof fixture>) => Effect.Effect<void, E, SqlClient.SqlClient>,
) => Effect.runPromise(fixture.pipe(Effect.flatMap(body), Effect.provide(pgliteLayer())));
