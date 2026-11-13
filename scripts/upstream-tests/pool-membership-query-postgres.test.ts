import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentTransformer } from "effect/sql/Statement";
import type { NativePoolAccount } from "../../.upstream/apps/hosted/server/src/implementation/pool-membership.ts";
import { app, organization, postgresFixture, until } from "./org-lock-postgres-fixture.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const [sdk, membership] = await Promise.all([
  load("packages/sdk/src/core.ts"),
  load("apps/hosted/server/src/implementation/pool-membership.ts"),
]);
const owner = `organization:${organization}`;
const provider = "prv_membership_query";
const home = "acc_membership_000";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of [
    "alter table executor_apps add column active_deployment text",
    "create table executor_deployments (id text primary key, requirements jsonb)",
    "create table hosted_account_access (account_id text primary key, organization_id text, kind text, personal_user_id text)",
    "create table hosted_app_account_links (app text, requirement text, subject text, account text, created_at timestamptz)",
    "create table executor_accounts (id text primary key, owner text, provider text, method text, credential_generation integer, encrypted_credentials bytea)",
    "create table executor_account_acquisitions (account text primary key, owner text, provider text, method text, generation integer, driver text, driver_revision text, revision text, removal jsonb, mirror_ready boolean, mirror_reference bytea)",
  ])
    yield* sql.unsafe(statement);
  yield* sql`update organization set metadata=${JSON.stringify({ basaltPools: { fixture: { app, membership: "executor-links-v1" } } })} where id=${organization}`;
  yield* sql`insert into executor_deployments values ('dpl_membership_query', ${JSON.stringify({ accounts: { models: { scope: "app", provider } } })})`;
  yield* sql`update executor_apps set active_deployment='dpl_membership_query' where id=${app}`;
  for (let index = 0; index < 32; index++) {
    const id = `acc_membership_${String(index).padStart(3, "0")}`;
    yield* sql`insert into executor_accounts values (${id},${owner},${provider},'key',1,decode('01','hex'))`;
    yield* sql`insert into executor_account_acquisitions values (${id},${owner},${provider},'key',1,'basalt-home','driver-one','binding-one',null,true,null)`;
    yield* sql`insert into hosted_account_access values (${id},${organization},'shared',null)`;
    yield* sql`insert into hosted_app_account_links values (${app},'models',null,${id},now())`;
  }
});

const runtime = (sql: SqlClient.SqlClient, hold = Effect.void) => {
  let reads = 0;
  const executor = {
    [sdk.StorageHost]: { transaction: sql.withTransaction },
    [sdk.AccountAcquisitionHost]: {
      source: ({ account }: { account: string }) =>
        Effect.gen(function* () {
          reads++;
          const [row] = yield* sql<{
            revision: string;
            generation: number;
          }>`select revision,generation from executor_account_acquisitions where account=${account}`;
          assert.ok(row);
          const binding = {
            account: sdk.AccountId.make(account),
            owner: sdk.OwnerId.make(owner),
            provider: sdk.ProviderId.make(provider),
            method: "key",
            generation: row.generation,
            driver: "basalt-home",
            driverRevision: "driver-one",
            revision: row.revision,
            removal: null,
          };
          return {
            binding,
            source: { kind: "driver", id: "basalt-home", version: "driver-one" },
            hostReference: Redacted.make(`fixture-reference-${row.revision}`),
            current: hold.pipe(Effect.as(binding)),
          };
        }),
    },
  };
  return { executor, reads: () => reads };
};

const nativeRead = (executor: ReturnType<typeof runtime>["executor"]) =>
  membership.nativePoolMembership(organization, app, executor) as Effect.Effect<
    { accounts: readonly (typeof NativePoolAccount.Type)[] },
    unknown,
    SqlClient.SqlClient
  >;

test("native membership evaluates policy once on PostgreSQL and refreshes exact references", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed;
      const { executor, reads } = runtime(sql);
      yield* Effect.tryPromise(() =>
        membership.bindPoolMembershipReferenceRuntime(executor, {}, Redacted.make("fixture-key")),
      );
      const first = yield* nativeRead(executor);
      assert.equal(first.accounts.length, 32);
      assert.equal(first.accounts[0].homeReference, "fixture-reference-binding-one");
      const statements: string[] = [];
      const cached = yield* nativeRead(executor).pipe(
        Effect.provideService(CurrentTransformer, (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile()[0]);
            return statement;
          }),
        ),
      );
      assert.deepEqual(cached, first);
      assert.equal(reads(), 32);
      const policyReads = statements.filter(
        (sql) => sql.includes("hosted_app_account_links") && sql.includes("hosted_account_access"),
      );
      console.log(
        JSON.stringify({
          accounts: 32,
          statements: statements.length,
          policyJoins: policyReads.length,
        }),
      );
      assert.equal(policyReads.length, 1, "one fresh policy evaluation per native membership read");

      yield* sql`update executor_account_acquisitions set revision='binding-two' where account=${home}`;
      const changed = yield* nativeRead(executor);
      assert.equal(changed.accounts[0].bindingRevision, "binding-two");
      assert.equal(changed.accounts[0].homeReference, "fixture-reference-binding-two");
      assert.equal(reads(), 64);
      yield* sql`delete from hosted_account_access where account_id=${home}`;
      const revoked = yield* nativeRead(executor);
      assert.equal(
        revoked.accounts.some((row: { account: string }) => row.account === home),
        false,
      );
      assert.equal(revoked.accounts.length, 31);
      yield* sql`delete from hosted_app_account_links where app=${app}`;
      assert.deepEqual((yield* nativeRead(executor)).accounts, []);
    }),
  );
});

test("native membership keeps account and binding locks until reference validation finishes", async () => {
  await postgresFixture(({ sql }) =>
    Effect.gen(function* () {
      yield* seed;
      const arrived = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const held = Deferred.succeed(arrived, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const { executor } = runtime(sql, held);
      const read = yield* Effect.forkChild(nativeRead(executor));
      yield* Deferred.await(arrived);
      const accountWrite = yield* Effect.forkChild(
        sql`update executor_accounts set credential_generation=2 where id=${home}`,
      );
      const bindingWrite = yield* Effect.forkChild(
        sql`update executor_account_acquisitions set revision='binding-two' where account=${home}`,
      );
      yield* until(
        sql<{
          count: number;
        }>`select count(*)::int as count from pg_stat_activity where datname=current_database()
          and application_name=current_setting('application_name') and wait_event_type='Lock'
          and query like 'update executor_%'`,
        (rows) => rows[0]?.count === 2,
      );
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(read);
      assert.equal(result.accounts[0].generation, 1);
      assert.equal(result.accounts[0].bindingRevision, "binding-one");
      yield* Fiber.join(accountWrite);
      yield* Fiber.join(bindingWrite);
      const [account] = yield* sql<{
        credential_generation: number;
      }>`select credential_generation from executor_accounts where id=${home}`;
      const [binding] = yield* sql<{
        revision: string;
      }>`select revision from executor_account_acquisitions where account=${home}`;
      assert.equal(account?.credential_generation, 2);
      assert.equal(binding?.revision, "binding-two");
    }),
  );
});
