import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { defaultKeyHasher } from "../../.upstream/apps/hosted/server/node_modules/@better-auth/api-key/dist/index.mjs";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { AccountId, AccountNotFound, AppId, StorageError, StorageHost, VersionId, type Account, type App, type Executor } from "../../.upstream/packages/sdk/src/core.ts";
import { organizationDefaults } from "../../.upstream/apps/hosted/server/src/implementation/organization-defaults.ts";
import { defaultExecutorAppSource } from "../../.upstream/apps/hosted/server/src/implementation/executor-app.ts";
import { OrganizationId, organizationOwner } from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import type { HostedApiDocument } from "../../.upstream/apps/hosted/server/src/contracts/api.ts";
import { queueDefaultManagedAccess } from "../../.upstream/apps/hosted/server/src/implementation/default-managed-access.ts";
import { createDataStepJournal } from "../../.upstream/packages/app-management/src/data-steps.ts";
import { ScheduleWakeup } from "../../.upstream/apps/hosted/server/src/contracts/schedules.ts";

const organization = OrganizationId.make("default-access-fixture");
const owner = organizationOwner(organization);
const appId = AppId.make("app_defaults");
const version = VersionId.make("dpl_defaults");
const document = { components: { securitySchemes: {} } } as unknown as HostedApiDocument;
const origin = "https://fixture.invalid";

const fixture = (run: (sql: SqlClient.SqlClient, setup: (user: string) => Effect.Effect<void, unknown>, failRetirement: () => void) => Effect.Effect<void, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of [
      "create table organization (id text primary key, metadata text)",
      'create table "user" (id text primary key, "emailVerified" boolean)',
      'create table member (id text, "organizationId" text, "userId" text, role text)',
      "create table executor_apps (id text primary key, owner text, active_deployment text)",
      "create table executor_deployments (id text primary key, requirements jsonb)",
      "create table executor_accounts (id text primary key, owner text, provider text, method text, fields jsonb)",
      "create table executor_account_connections (id text, owner text, state jsonb, created_at timestamptz default now())",
      "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text, created_at timestamptz)",
      "create table hosted_provisioning (kind text, organization_id text, user_id text, available_at timestamptz)",
      'create table apikey (id text primary key, "configId" text, name text, prefix text, start text, key text, "referenceId" text, enabled boolean, "rateLimitEnabled" boolean, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "createdAt" timestamptz, "updatedAt" timestamptz, metadata text)',
    ]) yield* sql.unsafe(statement);
    yield* createDataStepJournal("private_hosted");
    const definition = { name: "Executor", auth: { apiKey: { type: "secrets", provisioned: true }, oauth: { type: "oauth2" } } };
    const requirements = { accounts: { service: { provider: "provider-provisioned", scope: "user", cardinality: "one", definition } } };
    const files = (yield* defaultExecutorAppSource(origin, document)).files;
    assert.match(files.find((file) => file.path === "provider.ts")!.content, /apiKey: secrets\(\{ provisioned: true/);
    const accounts = { alex: "acc_alex", sam: "acc_sam" };
    yield* sql`insert into organization values (${organization}, ${JSON.stringify({ executorDefaults: { installed: true, app: appId, deployment: version }, executorKeyAccounts: accounts })})`;
    yield* sql`insert into executor_apps values (${appId}, ${owner}, ${version})`;
    yield* sql`insert into executor_deployments values (${version}, ${JSON.stringify(requirements)}::jsonb)`;
    for (const user of ["alex", "sam"]) {
      const id = accounts[user as keyof typeof accounts];
      const token = `exp_old_fixture_${user}`;
      const hash = yield* Effect.promise(() => defaultKeyHasher(token));
      yield* sql`insert into "user" values (${user}, true)`;
      yield* sql`insert into member values (${`member-${user}`}, ${organization}, ${user}, 'owner')`;
      yield* sql`insert into executor_accounts values (${id}, ${owner}, 'provider-legacy', 'apiKey', ${JSON.stringify({ token, organization })}::jsonb)`;
      yield* sql`insert into hosted_app_account_links values (${appId}, 'service', ${user}, ${id}, ${user}, now())`;
      yield* sql`insert into apikey (id, key, "referenceId", enabled, metadata) values (${id}, ${hash}, ${user}, true, ${JSON.stringify({ organization })})`;
    }
    let serial = 0;
    let fail = false;
    const app = { id: appId, owner, name: "Executor", activeVersion: version, requirements } as unknown as App;
    const executor = {
      [StorageHost]: { transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect) },
      apps: { get: () => Effect.succeed(app), source: () => Effect.succeed({ id: version, files }) },
      accounts: {
        get: ({ account }: { account: string }) => Effect.gen(function* () {
          const [row] = yield* sql`select id, owner, provider, method from executor_accounts where id = ${account}`;
          if (row === undefined) return yield* new AccountNotFound({ account: AccountId.make(account) });
          return row as unknown as Account;
        }),
        remove: ({ account }: { account: string }) => Effect.gen(function* () {
          if (fail) return yield* new StorageError();
          yield* sql`delete from executor_accounts where id = ${account}`;
          return { account };
        }),
      },
      managedAccounts: {
        add: (input: Parameters<Executor["managedAccounts"]["add"]>[0]) => Effect.gen(function* () {
          const id = AccountId.make(`acc_new_${++serial}`);
          yield* sql`insert into executor_accounts values (${id}, ${input.owner}, ${input.provider}, ${input.method}, ${JSON.stringify(Redacted.value(input.fields))}::jsonb)`;
          return { id, owner: input.owner, provider: input.provider, method: input.method } as Account;
        }),
        readCredentials: ({ account }: { account: string }) => Effect.gen(function* () {
          const [row] = yield* sql`select fields from executor_accounts where id = ${account}`;
          return Redacted.make(row!.fields as Record<string, unknown>);
        }),
      },
      webhooks: { sources: () => Effect.succeed([]), link: () => Effect.void, unlink: () => Effect.void },
    } as unknown as Executor;
    const initialize = yield* organizationDefaults(executor, origin, Effect.succeed(document));
    yield* run(sql, (user) => initialize(organization, { userId: user, name: user }), () => { fail = true; });
  })).pipe(Effect.provideService(ScheduleWakeup, Effect.void), Effect.provide(pgliteLayer())));

test("default app provider upgrade re-mints and links each member once, then revokes unlinked old keys", () =>
  fixture((sql, setup) => Effect.gen(function* () {
    for (const user of ["alex", "sam"]) { yield* setup(user); yield* setup(user); }
    const links = yield* sql`select l.subject, a.provider from hosted_app_account_links l join executor_accounts a on a.id = l.account order by l.subject`;
    assert.deepEqual(links, [{ subject: "alex", provider: "provider-provisioned" }, { subject: "sam", provider: "provider-provisioned" }]);
    assert.equal((yield* sql`select * from executor_accounts`).length, 2);
    assert.equal((yield* sql`select * from apikey where enabled = true`).length, 2);
    assert.equal((yield* sql`select * from apikey where id in ('acc_alex', 'acc_sam') and enabled = false`).length, 2);
    const [state] = yield* sql`select metadata::jsonb -> 'executorKeyAccounts' as accounts from organization`;
    const linked = yield* sql`select subject, account from hosted_app_account_links`;
    for (const link of linked) assert.equal((state!.accounts as Record<string, unknown>)[String(link.subject)], link.account);
  })));

test("default app re-mint preserves an old key and account still linked elsewhere", () =>
  fixture((sql, setup) => Effect.gen(function* () {
    yield* sql`insert into hosted_app_account_links values ('other-app', 'service', 'alex', 'acc_alex', 'alex', now())`;
    yield* setup("alex");
    assert.equal((yield* sql`select * from executor_accounts where id = 'acc_alex'`).length, 1);
    assert.equal((yield* sql`select * from apikey where id = 'acc_alex' and enabled = true`).length, 1);
    assert.equal((yield* sql`select * from hosted_app_account_links where app = 'other-app' and account = 'acc_alex'`).length, 1);
    assert.equal((yield* sql`select * from hosted_app_account_links where app = ${appId} and subject = 'alex' and account <> 'acc_alex'`).length, 1);
  })));

test("a failed default-account retirement rolls back the new key, link and metadata", () =>
  fixture((sql, setup, failRetirement) => Effect.gen(function* () {
    const state = yield* sql`select * from organization`;
    failRetirement();
    assert.equal((yield* Effect.exit(setup("alex")))._tag, "Failure");
    assert.deepEqual(yield* sql`select * from organization`, state);
    assert.equal((yield* sql`select * from apikey`).length, 2);
    assert.equal((yield* sql`select * from executor_accounts`).length, 2);
    assert.equal((yield* sql`select * from hosted_app_account_links where subject = 'alex' and account = 'acc_alex'`).length, 1);
    assert.equal((yield* sql`select * from apikey where enabled = true`).length, 2);
  })));

test("the journaled default-key sweep queues every retained holder once, including a demoted member", () =>
  fixture((sql, setup) => Effect.gen(function* () {
    yield* sql`update member set role = 'member' where "userId" = 'sam'`;
    yield* queueDefaultManagedAccess;
    yield* queueDefaultManagedAccess;
    assert.deepEqual(yield* sql`select user_id, available_at > now() + interval '14 minutes' as delayed from hosted_provisioning order by user_id`, [{ user_id: "alex", delayed: true }, { user_id: "sam", delayed: true }]);
    yield* setup("sam");
    assert.equal((yield* sql`select * from hosted_app_account_links l join executor_accounts a on a.id = l.account where l.subject = 'sam' and a.provider = 'provider-provisioned'`).length, 1);
    assert.equal((yield* sql`select * from apikey where id = 'acc_sam' and enabled = false`).length, 1);
    assert.equal((yield* sql`select * from private_hosted_data_steps where name = 'basalt-default-managed-access' and completed_at is not null`).length, 1);
  })));
