import assert from "node:assert/strict";
import { test } from "node:test";
import { Context, Deferred, Effect, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { App } from "../../.upstream/packages/sdk/src/contracts/apps.ts";
import type { Account } from "../../.upstream/packages/sdk/src/contracts/account.ts";
import type { Executor } from "../../.upstream/packages/sdk/src/contracts/executor.ts";
import type { AppId as AppIdentity } from "../../.upstream/packages/sdk/src/contracts/shared.ts";
import type { SourceFiles } from "../../.upstream/packages/sdk/src/contracts/source.ts";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(pathToFileURL(resolve(upstream, path)).href);
const [sdk, organizationContracts, scheduleContracts, lifecycleModule, defaults, source, upgrades] =
  await Promise.all([
    load("packages/sdk/src/core.ts"),
    load("apps/hosted/server/src/contracts/organization.ts"),
    load("apps/hosted/server/src/contracts/schedules.ts"),
    load("apps/hosted/server/src/implementation/resource-lifecycle.ts"),
    load("apps/hosted/server/src/implementation/pool-defaults.ts"),
    load("apps/hosted/server/src/implementation/pool-app-source.ts"),
    load("apps/hosted/server/src/implementation/pool-app-upgrades.ts"),
  ]);
const { AccountId, AppId, AppNameTaken, AppNotFound, StorageHost, VersionId } = sdk;
const { OrganizationId } = organizationContracts;
const { ScheduleWakeup } = scheduleContracts;
const { hostedResourceLifecycle } = lifecycleModule;
const { poolDefaults, poolName } = defaults;
const { poolAppFiles, poolAppVersion } = source;
const { queuePoolAppUpgrades } = upgrades;
const { createDataStepJournal } = await load("packages/app-management/src/data-steps.ts");
const { provision, selfHostProvisioningServices } = await load(
  "apps/hosted/server/src/implementation/provisioning.ts",
);
const { OrganizationDefaults } = await load(
  "apps/hosted/server/src/contracts/organization-defaults.ts",
);
import { verifyPoolToken } from "../../src/pool/token.ts";

const organization = Schema.decodeUnknownSync(OrganizationId)("organization-fixture");
const key = Redacted.make("ab".repeat(32));
const InProvisioningTransaction = Context.Reference<boolean>("pool-test/provisioning-transaction", {
  defaultValue: () => false,
});

/** Real SQL, resource policy hooks and account linking; compilation/Artifacts are replaced. */
const fixture = <A>(
  run: (input: {
    sql: SqlClient.SqlClient;
    executor: Executor;
    copies: { calls: number; collisions: number };
    reads: { get: number; source: number };
    setup: (user?: string) => ReturnType<typeof poolDefaults>;
  }) => Effect.Effect<A, unknown, unknown>,
  options: { raceCopies?: boolean } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const statement of [
          "create table organization (id text primary key, metadata text)",
          'create table "user" (id text primary key, name text, email text, "emailVerified" boolean)',
          'create table member (id text, "organizationId" text, "userId" text, role text)',
          "create table executor_apps (id text primary key, owner text, name text unique, active_deployment text, files jsonb, workspace jsonb, copied_from jsonb)",
          "create table executor_deployments (id text primary key, requirements jsonb)",
          "create table executor_accounts (id text primary key, owner text, provider text, token text)",
          "create table hosted_app_access (id text, organization_id text, creator_id text, audience text)",
          "create table hosted_account_access (account_id text, organization_id text, creator_id text, kind text, personal_user_id text)",
          "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text, created_at timestamptz)",
          "create table hosted_provisioning (id text primary key default gen_random_uuid()::text, kind text, organization_id text, user_id text, available_at timestamptz default now(), status text default 'queued', attempts integer default 0, updated_at timestamptz default now())",
        ])
          yield* sql.unsafe(statement);
        yield* createDataStepJournal("private_hosted");
        yield* sql`insert into organization values (${organization}, '{}')`;
        yield* sql`insert into "user" values ('person-a', 'Alex', 'alex@example.invalid', true),
      ('person-b', 'Alex', 'second@example.invalid', true), ('unverified', '', 'pending@example.invalid', false)`;
        yield* sql`insert into member values ('m1', ${organization}, 'person-a', 'member'),
      ('m2', ${organization}, 'person-b', 'member'), ('m3', ${organization}, 'unverified', 'owner')`;
        const lifecycle = yield* hostedResourceLifecycle;
        let nextId = 0;
        const copies = { calls: 0, collisions: 0 };
        const reads = { get: 0, source: 0 };
        const copying = yield* Deferred.make<void>();
        const requirements = {
          accounts: { pool: { provider: "provider-pool", scope: "app", cardinality: "one" } },
        };
        const get = (id: AppIdentity) =>
          Effect.gen(function* () {
            const [row] = yield* sql`select * from executor_apps where id = ${id}`;
            if (row === undefined) return yield* new AppNotFound({ app: id });
            return {
              id,
              owner: row.owner,
              name: row.name,
              activeVersion: row.active_deployment,
              copiedFrom: row.copied_from,
              requirements,
            } as unknown as App;
          });
        const executor = {
          [StorageHost]: {
            transaction: <A, E, R>(work: Effect.Effect<A, E, R>) =>
              sql.withTransaction(
                work.pipe(Effect.provideService(InProvisioningTransaction, true)),
              ),
          },
          apps: {
            copy: (input: Parameters<Executor["apps"]["copy"]>[0]) =>
              Effect.gen(function* () {
                assert.equal(
                  yield* InProvisioningTransaction,
                  false,
                  "copy must compile without the provisioning transaction",
                );
                copies.calls++;
                if (options.raceCopies) {
                  if (copies.calls === 2) yield* Deferred.succeed(copying, undefined);
                  yield* Deferred.await(copying);
                }
                // Like the SDK, compilation finishes before this short persistence transaction.
                return yield* sql.withTransaction(
                  Effect.gen(function* () {
                    const existing =
                      yield* sql`select id from executor_apps where name = ${input.name}`;
                    if (existing.length) {
                      copies.collisions++;
                      return yield* new AppNameTaken({ owner: input.owner, name: input.name! });
                    }
                    const id = Schema.decodeUnknownSync(AppId)(`app_fixture_${++nextId}`);
                    const version = Schema.decodeUnknownSync(VersionId)(`dpl_fixture_${++nextId}`);
                    assert.ok(typeof input.from !== "string" && "files" in input.from);
                    yield* sql`insert into executor_apps values (${id}, ${input.owner}, ${input.name}, ${version},
                    ${JSON.stringify(poolAppFiles)}::jsonb, ${JSON.stringify(poolAppFiles)}::jsonb,
                    ${JSON.stringify(input.from.origin)}::jsonb)`;
                    yield* sql`insert into executor_deployments values (${version}, ${JSON.stringify(requirements)}::jsonb)`;
                    const app = yield* get(id as AppIdentity);
                    yield* lifecycle.hooks.appCreated(app);
                    return app;
                  }),
                );
              }),
            list: ({ owner, name }: { owner: string; name: string }) =>
              Effect.gen(function* () {
                const rows = yield* sql<{
                  id: AppIdentity;
                }>`select id from executor_apps where owner = ${owner} and name = ${name}`;
                return yield* Effect.forEach(rows, (row) => get(row.id));
              }),
            get: ({ app }: { app: AppIdentity }) =>
              Effect.suspend(() => {
                reads.get++;
                return get(app);
              }),
            source: ({ app }: { app: AppIdentity }) =>
              Effect.gen(function* () {
                reads.source++;
                const [row] =
                  yield* sql`select active_deployment, files from executor_apps where id = ${app}`;
                return { id: row!.active_deployment, files: row!.files as SourceFiles };
              }),
            workspace: ({ app }: { app: AppIdentity }) =>
              Effect.gen(function* () {
                const [row] = yield* sql`select workspace from executor_apps where id = ${app}`;
                return { files: row!.workspace as SourceFiles };
              }),
            deploy: ({ app, files }: { app: AppIdentity; files: SourceFiles }) =>
              Effect.gen(function* () {
                assert.equal(
                  yield* InProvisioningTransaction,
                  false,
                  "deploy must compile without the provisioning transaction",
                );
                const version = `dpl_upgrade_${++nextId}`;
                yield* sql`update executor_apps set active_deployment = ${version}, files = ${JSON.stringify(files)}::jsonb,
            workspace = ${JSON.stringify(files)}::jsonb where id = ${app}`;
                yield* sql`insert into executor_deployments values (${version}, ${JSON.stringify(requirements)}::jsonb)`;
                return { app: yield* get(app) };
              }),
          },
          managedAccounts: {
            add: (input: Parameters<Executor["managedAccounts"]["add"]>[0]) =>
              Effect.gen(function* () {
                assert.equal(input.method, "token");
                assert.equal(input.label, "Pool access");
                const id = Schema.decodeUnknownSync(AccountId)(`acc_fixture_${++nextId}`);
                const fields = Redacted.value(input.fields) as { token: string };
                yield* sql`insert into executor_accounts values (${id}, ${input.owner}, ${input.provider}, ${fields.token})`;
                const account = { id, owner: input.owner } as Account;
                yield* lifecycle.hooks.accountCreated(account);
                return account;
              }),
          },
          webhooks: { sources: () => Effect.succeed([]), link: () => Effect.void },
        } as unknown as Executor;
        yield* lifecycle.attach(executor);
        return yield* run({
          sql,
          executor,
          copies,
          reads,
          setup: (user = "person-a") =>
            poolDefaults(executor, Option.some(key), organization, user),
        });
      }),
    ).pipe(
      Effect.provideService(ScheduleWakeup, Effect.void),
      Effect.provide(pgliteLayer()),
    ) as Effect.Effect<A, unknown>,
  );

test("installs a member's private app and personal linked account with a verifiable token, once", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      yield* setup();
      const apps = yield* sql`select * from executor_apps`;
      const accounts = yield* sql<{ token: string }>`select * from executor_accounts`;
      assert.equal(apps.length, 1);
      assert.equal(apps[0]!.name, "Alex's pool");
      assert.equal(accounts.length, 1);
      assert.deepEqual(
        yield* Effect.promise(() => verifyPoolToken(Redacted.value(key), accounts[0]!.token)),
        {
          pool: apps[0]!.id,
          owner: "person-a",
          organization,
        },
      );
      const [appAccess] = yield* sql`select * from hosted_app_access`;
      assert.equal(appAccess!.audience, "private");
      assert.equal(appAccess!.creator_id, "person-a");
      const [accountAccess] = yield* sql`select * from hosted_account_access`;
      assert.equal(accountAccess!.kind, "personal");
      assert.equal(accountAccess!.personal_user_id, "person-a");
      const [link] = yield* sql`select * from hosted_app_account_links`;
      assert.equal(link!.subject, null);
      assert.equal(link!.requirement, "pool");
      assert.equal(link!.linked_by, "person-a");
    }),
  );
});

test("deleted pools stay deleted; unverified members and missing keys create nothing", async () => {
  await fixture(({ sql, executor, setup }) =>
    Effect.gen(function* () {
      yield* setup("unverified");
      yield* poolDefaults(executor, Option.none(), organization, "person-b");
      assert.equal((yield* sql`select * from executor_apps`).length, 0);
      yield* setup();
      yield* sql`delete from executor_apps`;
      yield* setup();
      assert.equal((yield* sql`select * from executor_apps`).length, 0);
      assert.equal((yield* sql<{ token: string }>`select * from executor_accounts`).length, 1);
    }),
  );
});

test("two ordinary members get distinct pools and names under concurrent setup", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* Effect.all([setup(), setup(), setup("person-b")], { concurrency: "unbounded" });
      const apps = yield* sql`select name from executor_apps order by name`;
      assert.deepEqual(
        apps.map((app) => app.name),
        ["Alex's pool", "Alex's pool 2"],
      );
      const accounts = yield* sql<{ token: string }>`select token from executor_accounts`;
      const claims = yield* Effect.promise(() =>
        Promise.all(accounts.map((account) => verifyPoolToken(Redacted.value(key), account.token))),
      );
      assert.equal(new Set(claims.map((claim) => claim!.pool)).size, 2);
      assert.deepEqual(claims.map((claim) => claim!.owner).sort(), ["person-a", "person-b"]);
    }),
  );
});

test("upgrades an untouched recorded version and preserves owner deployments and workspace edits", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const old = JSON.stringify([{ path: "index.ts", content: "old bundled source" }]);
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
        '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
      yield* sql`update executor_apps set files = ${old}::jsonb, workspace = ${old}::jsonb`;
      yield* setup();
      const [upgraded] = yield* sql<{
        active_deployment: string;
        files: unknown;
      }>`select * from executor_apps`;
      assert.match(upgraded!.active_deployment, /^dpl_upgrade_/);
      assert.deepEqual(upgraded!.files, poolAppFiles);
      const [org] = yield* sql<{
        metadata: { basaltPools: Record<string, { version: string }> };
      }>`select metadata::jsonb as metadata from organization`;
      assert.equal(org!.metadata.basaltPools["person-a"].version, upgraded!.active_deployment);
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
        '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
      yield* sql`update executor_apps set files = ${old}::jsonb, workspace = '[{"path":"index.ts","content":"editing"}]'::jsonb`;
      yield* setup();
      assert.equal(
        (yield* sql`select active_deployment from executor_apps`)[0]!.active_deployment,
        upgraded!.active_deployment,
      );
      yield* sql`update executor_apps set active_deployment = 'owner-deployment', workspace = ${old}::jsonb`;
      yield* setup();
      assert.equal(
        (yield* sql`select active_deployment from executor_apps`)[0]!.active_deployment,
        "owner-deployment",
      );
      assert.equal((yield* sql<{ token: string }>`select * from executor_accounts`).length, 1);
    }),
  );
});

test("bundle rollouts queue every verified member once with delayed durable jobs", async () => {
  await fixture(({ sql }) =>
    Effect.gen(function* () {
      const queue = queuePoolAppUpgrades();
      yield* Effect.all([queue, queuePoolAppUpgrades()], { concurrency: "unbounded" });
      yield* queue;
      const jobs =
        yield* sql`select user_id, available_at > now() + interval '14 minutes' as delayed from hosted_provisioning order by user_id`;
      assert.deepEqual(jobs, [
        { user_id: "person-a", delayed: true },
        { user_id: "person-b", delayed: true },
      ]);
      const markers =
        yield* sql`select name, completed_at is not null as completed from private_hosted_data_steps`;
      assert.deepEqual(markers, [{ name: `basalt-pools:${poolAppVersion}`, completed: true }]);
      yield* queuePoolAppUpgrades("next-bundle");
      assert.equal((yield* sql`select * from hosted_provisioning`).length, 4);
    }),
  );
});

test("completed rollouts skip membership scans in fresh isolates and all SQL in the same isolate", async () => {
  await fixture(({ sql }) =>
    Effect.gen(function* () {
      const queue = queuePoolAppUpgrades();
      yield* queue;
      yield* sql`drop table member`;
      // A fresh isolate needs only the global journal marker, even when bulk reads are unavailable.
      yield* queuePoolAppUpgrades();
      yield* sql`drop table private_hosted_data_steps`;
      // The completed isolate does not even query that marker again.
      yield* queue;
    }),
  );
});

test("a failed rollout commits neither jobs nor completion and remains retryable in its isolate", async () => {
  await fixture(({ sql }) =>
    Effect.gen(function* () {
      const queue = queuePoolAppUpgrades();
      yield* sql`alter table hosted_provisioning add constraint reject_rollout check (false)`;
      const failed = yield* Effect.exit(queue);
      assert.equal(failed._tag, "Failure");
      assert.equal((yield* sql`select * from private_hosted_data_steps`).length, 0);
      assert.equal((yield* sql`select * from hosted_provisioning`).length, 0);
      yield* sql`alter table hosted_provisioning drop constraint reject_rollout`;
      yield* queue;
      assert.equal((yield* sql`select * from hosted_provisioning`).length, 2);
    }),
  );
});

test("pool names fall back to the email local part and stay within the SDK limit", () => {
  assert.equal(poolName("", "person@example.invalid"), "person's pool");
  assert.ok(poolName("a".repeat(500), "person@example.invalid", 100).length <= 120);
});

test("ordinary member jobs retry pool failures after the default setup has run", async () => {
  await fixture(({ sql, executor }) =>
    Effect.gen(function* () {
      yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id)
      values ('job-pool', 'member', ${organization}, 'person-a')`;
      let defaultsRan = 0;
      const run = (signingKey: Redacted.Redacted<string>) =>
        provision("job-pool", selfHostProvisioningServices).pipe(
          Effect.provideService(
            OrganizationDefaults,
            (_organization: unknown, member: { userId: string }) => {
              defaultsRan++;
              return poolDefaults(executor, Option.some(signingKey), organization, member.userId);
            },
          ),
        );
      const failed = yield* Effect.exit(run(Redacted.make("invalid-key")));
      assert.equal(failed._tag, "Failure");
      assert.equal(defaultsRan, 1);
      assert.equal((yield* sql`select status from hosted_provisioning`)[0]!.status, "queued");
      assert.equal((yield* sql`select * from executor_apps`).length, 1);
      assert.equal((yield* sql`select * from executor_accounts`).length, 0);
      yield* run(key);
      assert.equal((yield* sql`select status from hosted_provisioning`)[0]!.status, "succeeded");
      assert.equal((yield* sql`select * from executor_apps`).length, 1);
    }),
  );
});

test(
  "racing same-member copies adopt the winner and create one account and link",
  { timeout: 10_000 },
  async () => {
    await fixture(
      ({ sql, setup, copies }) =>
        Effect.gen(function* () {
          yield* Effect.all([setup(), setup()], { concurrency: "unbounded" });
          assert.equal(copies.calls, 2);
          assert.equal(copies.collisions, 1);
          const apps = yield* sql`select name from executor_apps`;
          assert.deepEqual(
            apps.map((app) => app.name),
            ["Alex's pool"],
          );
          assert.equal((yield* sql`select * from executor_accounts`).length, 1);
          assert.equal((yield* sql`select * from hosted_app_account_links`).length, 1);
        }),
      { raceCopies: true },
    );
  },
);

test("an upgrade does not replace a pool record changed during compilation", async () => {
  await fixture(({ sql, executor, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const old = JSON.stringify([{ path: "index.ts", content: "old bundled source" }]);
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
        '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
      yield* sql`update executor_apps set files = ${old}::jsonb, workspace = ${old}::jsonb`;
      const concurrent = {
        ...executor,
        apps: {
          ...executor.apps,
          deploy: (input: Parameters<Executor["apps"]["deploy"]>[0]) =>
            executor.apps.deploy(input).pipe(
              Effect.tap(
                () => sql`update organization set metadata = jsonb_set(metadata::jsonb,
            '{basaltPools,person-a,version}', '"dpl_record_changed_during_compile"')::text`,
              ),
            ),
        },
      };
      yield* poolDefaults(concurrent, Option.some(key), organization, "person-a");
      const [row] =
        yield* sql`select metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'version' as version from organization`;
      assert.equal(row!.version, "dpl_record_changed_during_compile");
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
    }),
  );
});

test("a same-name app created by the member from another origin gets a suffix", async () => {
  await fixture(({ sql, executor, setup }) =>
    Effect.gen(function* () {
      const copy = executor.apps.copy({
        owner: organizationContracts.organizationOwner(organization),
        name: "Alex's pool",
        from: {
          files: poolAppFiles,
          origin: {
            reference: "https://example.invalid/another-app",
            name: "Another app",
            commit: null,
          },
          activation: "deploy",
        },
      });
      const unrelated: App = yield* lifecycleModule.memberAppCreation("person-a")(copy);
      yield* setup();
      assert.equal((yield* sql`select * from executor_apps`).length, 2);
      const [link] = yield* sql`select app from hosted_app_account_links`;
      assert.notEqual(link!.app, unrelated.id);
      const [pool] = yield* sql`select name from executor_apps where id = ${link!.app}`;
      assert.equal(pool!.name, "Alex's pool 2");
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
    }),
  );
});

test("current bundle records skip SDK app reads and legacy records are marked after one full check", async () => {
  await fixture(({ sql, setup, reads }) =>
    Effect.gen(function* () {
      yield* setup();
      const initial = { ...reads };
      yield* setup();
      assert.deepEqual(reads, initial);
      const [recorded] =
        yield* sql`select metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'bundle' as bundle from organization`;
      assert.equal(recorded!.bundle, poolAppVersion);
      // Existing installations have no bundle field; verify their source once without redeploying.
      yield* sql`update organization set metadata = (metadata::jsonb #- '{basaltPools,person-a,bundle}')::text`;
      yield* setup();
      assert.equal(reads.get, initial.get + 1);
      assert.equal(reads.source, initial.source + 1);
      const checked = { ...reads };
      yield* setup();
      assert.deepEqual(reads, checked);
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
    }),
  );
});
