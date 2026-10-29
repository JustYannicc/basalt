import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Context, Crypto, Deferred, Effect, Logger, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, basename } from "node:path";
import { readFileSync } from "node:fs";
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
const { AccountId, AppId, AppNameTaken, AppNotFound, AccountNotFound, StorageHost, VersionId } =
  sdk;
const { AccountProvisioned } = sdk;
const { OrganizationId } = organizationContracts;
const { ScheduleWakeup } = scheduleContracts;
const { hostedResourceLifecycle } = lifecycleModule;
const { poolDefaults, poolName, withPoolDefaults, PoolAppSource } = defaults;
const { poolAppVersion, poolAppAssetPath } = source;
const poolAppFiles: SourceFiles = Schema.decodeUnknownSync(sdk.SourceFiles)(
  JSON.parse(
    readFileSync(
      resolve(upstream, "apps/hosted/cloud/.generated/pool-app", basename(poolAppAssetPath)),
      "utf8",
    ),
  ),
);
const { queuePoolAppUpgrades, poolReconcileRevision, cleanupRetiredPoolAccounts } = upgrades;
const { poolTokenKeyVersion } = await load("apps/hosted/server/src/implementation/pool-account.ts");
const { createDataStepJournal } = await load("packages/app-management/src/data-steps.ts");
const { provision, selfHostProvisioningServices } = await load(
  "apps/hosted/server/src/implementation/provisioning.ts",
);
const { OrganizationDefaults } = await load(
  "apps/hosted/server/src/contracts/organization-defaults.ts",
);
const { AccessLifecycle } = await load("apps/hosted/server/src/contracts/access-lifecycle.ts");
const { linkAppAccount } = await load("apps/hosted/server/src/implementation/app-accounts.ts");
const { identifyProvider } = await load("packages/sdk/src/implementation/provider.ts");
import { signPoolToken, verifyPoolToken } from "../../src/pool/token.ts";

const providerCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});
const poolProviderIdentity = async (provisioned: boolean) => {
  const identified = Schema.decodeUnknownSync(Schema.Struct({ identity: Schema.String }))(
    await Effect.runPromise(
      identifyProvider(
        {
          name: "Pool",
          auth: {
            token: {
              type: "secrets",
              label: "Pool access",
              ...(provisioned ? { provisioned: true } : {}),
              fields: {
                type: "object",
                properties: { token: { type: "string", minLength: 1 } },
                required: ["token"],
              },
            },
          },
        },
        providerCrypto,
      ),
    ),
  );
  return identified.identity;
};
const [oldPoolProvider, provisionedPoolProvider] = await Promise.all([
  poolProviderIdentity(false),
  poolProviderIdentity(true),
]);
assert.notEqual(oldPoolProvider, provisionedPoolProvider);

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
    changeProvider: () => void;
    failNextRemoval: () => void;
    setup: (
      user?: string,
      signingKey?: Redacted.Redacted<string>,
      team?: typeof organization,
    ) => ReturnType<typeof poolDefaults>;
  }) => Effect.Effect<A, unknown, unknown>,
  options: {
    raceCopies?: boolean;
    poolSource?: { version: string; files: Effect.Effect<SourceFiles, unknown> };
    beforeCopyCommit?: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>;
    beforeDeployCommit?: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>;
    afterDeployCommit?: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>;
  } = {},
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
          "create table executor_deployments (id text primary key, requirements jsonb, app text, files jsonb, created_at timestamptz default clock_timestamp())",
          "create table executor_accounts (id text primary key, owner text, provider text, token text, method text, label text)",
          // Account deletion reads connection state to tell app-acquired accounts apart.
          "create table executor_account_connections (id text primary key, owner text, state jsonb, created_at timestamptz default now())",
          "create table hosted_app_access (id text, organization_id text, creator_id text, audience text, revision text default gen_random_uuid()::text)",
          "create table hosted_account_access (account_id text, organization_id text, creator_id text, kind text, personal_user_id text)",
          "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text, created_at timestamptz)",
          "create table hosted_provisioning (id text primary key default gen_random_uuid()::text, kind text, organization_id text, user_id text, available_at timestamptz default now(), status text default 'queued', attempts integer default 0, updated_at timestamptz default now())",
        ])
          yield* sql.unsafe(statement);
        yield* createDataStepJournal("private_hosted");
        yield* sql`insert into organization values (${organization}, '{}')`;
        yield* sql`insert into "user" values ('person-a', 'Alex', 'alex@example.invalid', true),
      ('person-b', 'Alex', 'second@example.invalid', true),
      ('invited', 'Guest', 'guest@example.invalid', true), ('admin', 'Admin', 'admin@example.invalid', true), ('unverified', '', 'pending@example.invalid', false)`;
        yield* sql`insert into member values ('m1', ${organization}, 'person-a', 'owner'),
      ('m2', ${organization}, 'person-b', 'owner'), ('m3', ${organization}, 'unverified', 'owner'),
      ('m4', ${organization}, 'invited', 'member'), ('m5', ${organization}, 'admin', 'admin')`;
        const lifecycle = yield* hostedResourceLifecycle;
        let nextId = 0;
        let removalFails = false;
        const copies = { calls: 0, collisions: 0 };
        const reads = { get: 0, source: 0 };
        const copying = yield* Deferred.make<void>();
        let poolProvisioned = false;
        const requirements = {
          accounts: {
            pool: {
              provider: oldPoolProvider,
              scope: "app",
              cardinality: "one",
              definition: {
                auth: { token: { type: "secrets", provisioned: poolProvisioned } },
              },
            },
          },
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
                if (options.beforeCopyCommit) yield* options.beforeCopyCommit(sql);
                // Like the SDK, compilation finishes before this short persistence transaction.
                return yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* lifecycle.hooks.appDeploying?.(input.owner) ?? Effect.void;
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
                    ${JSON.stringify(input.from.files)}::jsonb, ${JSON.stringify(input.from.files)}::jsonb,
                    ${JSON.stringify(input.from.origin)}::jsonb)`;
                    yield* sql`insert into executor_deployments values (${version}, ${JSON.stringify(requirements)}::jsonb,
                    ${id}, ${JSON.stringify(input.from.files)}::jsonb)`;
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
            source: ({ app, version }: { app: AppIdentity; version?: string }) =>
              Effect.gen(function* () {
                reads.source++;
                if (version !== undefined) {
                  const [row] =
                    yield* sql`select files, created_at from executor_deployments where id = ${version} and app = ${app}`;
                  return {
                    id: version,
                    files: row!.files as SourceFiles,
                    createdAt: new Date(row!.created_at as string),
                  };
                }
                const [row] =
                  yield* sql`select a.active_deployment, a.files, d.created_at from executor_apps a
                left join executor_deployments d on d.id = a.active_deployment where a.id = ${app}`;
                return {
                  id: row!.active_deployment,
                  files: row!.files as SourceFiles,
                  createdAt: new Date((row!.created_at as string | null) ?? 0),
                };
              }),
            versions: ({ app }: { app: AppIdentity }) =>
              sql<{
                id: string;
                created_at: string;
              }>`select id, created_at from executor_deployments where app = ${app}`.pipe(
                Effect.map((rows) =>
                  rows.map((row) => ({ id: row.id, createdAt: new Date(row.created_at) })),
                ),
              ),
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
                if (options.beforeDeployCommit) yield* options.beforeDeployCommit(sql);
                const deployed = yield* sql.withTransaction(
                  Effect.gen(function* () {
                    const current = yield* get(app);
                    yield* lifecycle.hooks.appDeploying?.(current.owner) ?? Effect.void;
                    const version = `dpl_upgrade_${++nextId}`;
                    // Like the SDK, a file deploy never writes Git, so the workspace keeps main.
                    yield* sql`update executor_apps set active_deployment = ${version}, files = ${JSON.stringify(files)}::jsonb
                    where id = ${app}`;
                    yield* sql`insert into executor_deployments values (${version}, ${JSON.stringify(requirements)}::jsonb,
                    ${app}, ${JSON.stringify(files)}::jsonb)`;
                    return { app: yield* get(app) };
                  }),
                );
                if (options.afterDeployCommit) yield* options.afterDeployCommit(sql);
                return deployed;
              }),
          },
          accounts: {
            remove: (input: Parameters<Executor["accounts"]["remove"]>[0]) =>
              Effect.gen(function* () {
                assert.equal(
                  yield* InProvisioningTransaction,
                  true,
                  "retirement uses the setup transaction",
                );
                if (removalFails) {
                  removalFails = false;
                  return yield* new sdk.StorageError();
                }
                const [row] =
                  yield* sql`select id, owner from executor_accounts where id = ${input.account}`;
                if (row !== undefined)
                  yield* lifecycle.hooks.accountRemoving(row as unknown as Account);
                yield* sql`delete from hosted_account_access where account_id = ${input.account}`;
                yield* sql`delete from executor_accounts where id = ${input.account}`;
                return { account: input.account };
              }),
            update: (input: Parameters<Executor["accounts"]["update"]>[0]) =>
              Effect.gen(function* () {
                const [row] = yield* sql`update executor_accounts set label = ${input.label}
                where id = ${input.account} and owner = ${input.owner} returning id, owner`;
                if (row === undefined)
                  return yield* new AccountNotFound({ account: input.account });
                return row as unknown as Account;
              }),
          },
          managedAccounts: {
            readCredentials: (input: { account: string; owner: string }) =>
              Effect.gen(function* () {
                const [row] =
                  yield* sql`select token from executor_accounts where id = ${input.account} and owner = ${input.owner}`;
                if (row === undefined)
                  return yield* new AccountNotFound({ account: input.account });
                return Redacted.make({ token: row.token });
              }),
            add: (input: Parameters<Executor["managedAccounts"]["add"]>[0]) =>
              Effect.gen(function* () {
                assert.equal(input.method, "token");
                assert.equal(input.label, "Pool access");
                const id = Schema.decodeUnknownSync(AccountId)(`acc_fixture_${++nextId}`);
                const fields = Redacted.value(input.fields) as { token: string };
                yield* sql`insert into executor_accounts values (${id}, ${input.owner}, ${input.provider}, ${fields.token}, ${input.method}, ${input.label})`;
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
          failNextRemoval: () => {
            removalFails = true;
          },
          changeProvider: () => {
            requirements.accounts.pool.provider = provisionedPoolProvider;
            poolProvisioned = true;
            requirements.accounts.pool.definition.auth.token.provisioned = poolProvisioned;
          },
          setup: (user = "person-a", signingKey = key, team = organization) =>
            poolDefaults(executor, Option.some(signingKey), team, user),
        });
      }),
    ).pipe(
      Effect.provideService(ScheduleWakeup, Effect.void),
      Effect.provideService(
        PoolAppSource,
        options.poolSource ?? { version: poolAppVersion, files: Effect.succeed(poolAppFiles) },
      ),
      Effect.provide(pgliteLayer()),
    ) as Effect.Effect<A, unknown>,
  );

test("installs an owner's private app and personal linked account with a verifiable token, once", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      yield* setup();
      const apps = yield* sql`select * from executor_apps`;
      const accounts = yield* sql<{ token: string }>`select * from executor_accounts`;
      assert.equal(apps.length, 1);
      assert.equal(apps[0]!.name, "Alex's pool");
      const [record]: readonly any[] =
        yield* sql`select metadata::jsonb -> 'basaltPools' -> 'person-a' as pool from organization where id = ${organization}`;
      assert.equal(
        record!.pool.app,
        apps[0]!.id,
        "provisioning writes the reserved pool record through SQL",
      );
      assert.equal(accounts.length, 1);
      const payload = JSON.parse(
        Buffer.from(accounts[0]!.token.split(".")[1]!, "base64url").toString(),
      );
      assert.equal(typeof payload.kid, "string");
      assert.ok(payload.kid.length > 0, "minted tokens carry the signing-key id");
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

test("two owners get distinct pools and names under concurrent setup", async () => {
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

/** Run `work` and collect the "Pool reconcile" lines it logs. */
const reconcileLines = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lines: unknown[] = [];
    const capture = Logger.make((options) => {
      const [message, fields] = options.message as readonly unknown[];
      if (message === "Pool reconcile") lines.push(fields);
    });
    yield* work.pipe(Effect.provide(Logger.layer([capture])));
    return lines;
  });

test("every reconcile of a recorded pool logs one decision with counts only", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const [pool] = yield* sql<{ id: string }>`select id from executor_apps`;
      const app = pool!.id;
      const [oldLink] = yield* sql<{
        account: string;
      }>`select account from hosted_app_account_links`;
      const [oldAccount] = yield* sql<{ provider: string }>`select provider from executor_accounts`;
      const decisions = (work: Effect.Effect<unknown, unknown, never>) =>
        reconcileLines(work).pipe(
          Effect.map((lines) => lines.map((line) => (line as { decision: string }).decision)),
        );
      assert.deepEqual(yield* reconcileLines(setup()), [
        { app, decision: "already-current", accessRepaired: 0, tokenRepaired: false },
      ]);
      const old = JSON.stringify([{ path: "index.ts", content: "old bundled source" }]);
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
        '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
      yield* sql`update executor_apps set files = ${old}::jsonb, workspace = ${old}::jsonb`;
      assert.deepEqual(yield* decisions(setup()), ["upgraded"]);
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
        '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
      yield* sql`update executor_apps set files = ${old}::jsonb, workspace = '[{"path":"index.ts","content":"editing"}]'::jsonb`;
      assert.deepEqual(yield* decisions(setup()), ["source-edited"]);
      const [editedLink] = yield* sql<{
        account: string;
        provider: string;
        token: string;
      }>`select l.account, a.provider, a.token from hosted_app_account_links l
        join executor_accounts a on a.id = l.account where l.app = ${app}`;
      assert.equal(editedLink!.account, oldLink!.account);
      assert.equal(editedLink!.provider, oldPoolProvider);
      assert.deepEqual(
        yield* Effect.promise(() => verifyPoolToken(Redacted.value(key), editedLink!.token)),
        { pool: app, owner: "person-a", organization },
        "a source-edited pool keeps a working link to its old provider identity",
      );
      const [beforeOwnerDeployment] = yield* sql<{ version: string; bundle: string }>`select
        metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'version' as version,
        metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'bundle' as bundle from organization`;
      const [currentApp] = yield* sql<{
        active_deployment: string;
      }>`select active_deployment from executor_apps`;
      const [currentDeployment] = yield* sql<{ requirements: unknown }>`select requirements
        from executor_deployments where id = ${currentApp!.active_deployment}`;
      yield* sql`insert into executor_deployments (id, requirements, app, files)
        values ('owner-deployment', ${JSON.stringify(currentDeployment!.requirements)}::jsonb, ${app}, ${old}::jsonb)`;
      yield* sql`update executor_apps set active_deployment = 'owner-deployment', files = ${old}::jsonb,
        workspace = ${old}::jsonb`;
      assert.deepEqual(yield* decisions(setup()), ["version-mismatch"]);
      assert.deepEqual(
        yield* sql<{ version: string; bundle: string }>`select
          metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'version' as version,
          metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'bundle' as bundle from organization`,
        [beforeOwnerDeployment!],
        "an owner deployment with different files does not advance the recorded pool bundle",
      );
      assert.deepEqual(
        yield* sql<{ account: string }>`select account from hosted_app_account_links`,
        [oldLink!],
        "older source decisions keep the existing account link",
      );
      assert.deepEqual(
        yield* sql<{
          provider: string;
        }>`select provider from executor_accounts where id = ${oldLink!.account}`,
        [oldAccount!],
        "older source decisions keep the account's provider identity",
      );
      yield* sql`delete from hosted_app_access where id = ${app}`;
      const [repair] = yield* reconcileLines(setup());
      assert.equal((repair as { accessRepaired: number }).accessRepaired, 1);
      // Nothing but the app id, the decision and counts.
      assert.deepEqual(Object.keys(repair as object).sort(), [
        "accessRepaired",
        "app",
        "decision",
        "tokenRepaired",
      ]);
    }),
  );
});

test("a workspace left on an earlier pool bundle by a file deploy still upgrades", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const decisions = (work: Effect.Effect<unknown, unknown, never>) =>
        reconcileLines(work).pipe(
          Effect.map((lines) => lines.map((line) => (line as { decision: string }).decision)),
        );
      const stale = (bundle: string, files: string) =>
        Effect.gen(function* () {
          yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
            '{basaltPools,person-a,bundle}', ${JSON.stringify(bundle)})::text`;
          const [app] = yield* sql<{
            active_deployment: string;
          }>`select active_deployment from executor_apps`;
          yield* sql`update executor_deployments set files = ${files}::jsonb where id = ${app!.active_deployment}`;
          yield* sql`update executor_apps set files = ${files}::jsonb`;
        });
      const first = JSON.stringify([{ path: "index.ts", content: "first bundled source" }]);
      const second = JSON.stringify([{ path: "index.ts", content: "second bundled source" }]);
      // The pool was installed with an older bundle, and main holds it.
      yield* stale("first-bundle", first);
      yield* sql`update executor_apps set workspace = ${first}::jsonb`;
      assert.deepEqual(yield* decisions(setup()), ["upgraded"]);
      // That upgrade deployed files only, so main still holds the first bundle while the next
      // bundle ships. It's behind, not edited.
      yield* stale("second-bundle", second);
      assert.deepEqual(yield* decisions(setup()), ["upgraded"]);
      const [upgraded] = yield* sql<{
        files: unknown;
        workspace: unknown;
      }>`select * from executor_apps`;
      assert.deepEqual(upgraded!.files, poolAppFiles);
      assert.deepEqual(upgraded!.workspace, JSON.parse(first));
      // Work saved to main that no version ran is still someone's edit.
      yield* stale("third-bundle", second);
      yield* sql`update executor_apps set workspace = '[{"path":"index.ts","content":"editing"}]'::jsonb`;
      assert.deepEqual(yield* decisions(setup()), ["source-edited"]);
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

test("bundle rollouts queue verified owners once while rotation has its own journal", async () => {
  await fixture(({ sql }) =>
    Effect.gen(function* () {
      const queue = queuePoolAppUpgrades(key);
      yield* Effect.all([queue, queuePoolAppUpgrades(key)], { concurrency: "unbounded" });
      yield* queue;
      const jobs =
        yield* sql`select user_id, available_at > now() + interval '14 minutes' as delayed from hosted_provisioning order by user_id`;
      assert.deepEqual(jobs, [
        { user_id: "person-a", delayed: true },
        { user_id: "person-b", delayed: true },
      ]);
      const markers =
        yield* sql`select name, completed_at is not null as completed from private_hosted_data_steps`;
      assert.deepEqual(markers, [
        {
          name: "basalt-pool-tokens",
          completed: true,
        },
        {
          name: `basalt-pools:${poolAppVersion}:reconcile-${poolReconcileRevision}`,
          completed: true,
        },
      ]);
      yield* queuePoolAppUpgrades(key, "next-bundle");
      assert.equal((yield* sql`select * from hosted_provisioning`).length, 4);
    }),
  );
});

test("a reconcile revision reconciles every pool once even when the bundle is unchanged", async () => {
  await fixture(({ sql }) =>
    Effect.gen(function* () {
      // A rollout of this bundle finished under the earlier step name, before the revision existed.
      yield* sql`insert into private_hosted_data_steps (name, run, mode, completed_at)
        values (${`basalt-pools:${poolAppVersion}`}, 'apply', 'apply', now())`;
      yield* queuePoolAppUpgrades(key);
      const members = yield* sql`select user_id from hosted_provisioning where kind = 'member'
        and id not like 'basalt-pool-token:%' order by user_id`;
      assert.deepEqual(members, [{ user_id: "person-a" }, { user_id: "person-b" }]);
      // The same revision never queues twice.
      yield* queuePoolAppUpgrades(key);
      assert.equal(
        (yield* sql`select * from hosted_provisioning where kind = 'member' and id not like 'basalt-pool-token:%'`)
          .length,
        2,
      );
    }),
  );
});

test("completed rollouts skip membership scans in fresh isolates and all SQL in the same isolate", async () => {
  await fixture(({ sql }) =>
    Effect.gen(function* () {
      const queue = queuePoolAppUpgrades(key);
      yield* queue;
      yield* sql`drop table member`;
      // A fresh isolate needs only the global journal marker, even when bulk reads are unavailable.
      yield* queuePoolAppUpgrades(key);
      yield* sql`drop table private_hosted_data_steps`;
      // The completed isolate does not even query that marker again.
      yield* queue;
    }),
  );
});

test("a failed rollout commits neither jobs nor completion and remains retryable in its isolate", async () => {
  await fixture(({ sql }) =>
    Effect.gen(function* () {
      const queue = queuePoolAppUpgrades(key);
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

test("current bundles still check credentials and legacy bundles get one source check", async () => {
  await fixture(({ sql, setup, reads }) =>
    Effect.gen(function* () {
      yield* setup();
      const initial = { ...reads };
      yield* setup();
      assert.equal(reads.source, initial.source);
      assert.equal(reads.get, initial.get + 2);
      const [recorded] =
        yield* sql`select metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'bundle' as bundle from organization`;
      assert.equal(recorded!.bundle, poolAppVersion);
      // Existing installations have no bundle field; verify their source once without redeploying.
      yield* sql`update organization set metadata = (metadata::jsonb #- '{basaltPools,person-a,bundle}')::text`;
      yield* setup();
      assert.equal(reads.get, initial.get + 4);
      assert.equal(reads.source, initial.source + 1);
      const checked = { ...reads };
      yield* setup();
      assert.equal(reads.source, checked.source);
      assert.equal(reads.get, checked.get + 2);
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
    }),
  );
});

test("invited members and admins get no pool; ownership is scoped to each organization", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      const other = Schema.decodeUnknownSync(OrganizationId)("organization-other");
      yield* sql`insert into organization values (${other}, '{}')`;
      yield* sql`insert into member values ('other-member', ${other}, 'person-a', 'member')`;
      yield* setup("invited");
      yield* setup("admin");
      yield* setup("person-a", key, other);
      assert.equal((yield* sql`select * from executor_apps`).length, 0);
      yield* setup();
      yield* setup();
      assert.equal((yield* sql`select * from executor_apps`).length, 1);
      const [access] = yield* sql`select organization_id, creator_id from hosted_app_access`;
      assert.deepEqual(access, { organization_id: organization, creator_id: "person-a" });
      const [foreign] = yield* sql<{
        metadata: string;
      }>`select metadata from organization where id = ${other}`;
      assert.deepEqual(JSON.parse(foreign!.metadata), {});
    }),
  );
});

test("promotion installs once; demotion leaves the pool, token and pending upgrade untouched", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup("invited");
      assert.equal((yield* sql`select * from executor_apps`).length, 0);
      yield* sql`update member set role = 'owner' where "userId" = 'invited'`;
      yield* setup("invited");
      yield* setup("invited");
      assert.equal((yield* sql`select * from executor_apps`).length, 1);
      yield* sql`update member set role = 'member' where "userId" = 'invited'`;
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
      '{basaltPools,invited,bundle}', '"previous-bundle"')::text`;
      const old = JSON.stringify([{ path: "index.ts", content: "previous pool" }]);
      yield* sql`update executor_apps set files = ${old}::jsonb, workspace = ${old}::jsonb`;
      yield* sql`delete from hosted_app_account_links`;
      const before = yield* sql`select * from organization`;
      const apps = yield* sql`select * from executor_apps`;
      const accounts = yield* sql`select * from executor_accounts`;
      yield* setup("invited");
      assert.deepEqual(yield* sql`select * from organization`, before);
      assert.deepEqual(yield* sql`select * from executor_apps`, apps);
      assert.deepEqual(yield* sql`select * from executor_accounts`, accounts);
      assert.equal((yield* sql`select * from hosted_app_account_links`).length, 0);
      yield* queuePoolAppUpgrades(key);
      const jobs = yield* sql`select user_id from hosted_provisioning order by user_id`;
      assert.deepEqual(jobs, [{ user_id: "person-a" }, { user_id: "person-b" }]);
    }),
  );
});

test("a rotated signing key re-mints and re-links once, deletes the unlinked old account and journals the key", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const [original] = yield* sql`select * from executor_accounts`;
      const rotated = Redacted.make("cd".repeat(32));
      yield* setup("person-a", rotated);
      yield* setup("person-a", rotated);
      const [link] = yield* sql`select * from hosted_app_account_links`;
      const [active] = yield* sql<{
        token: string;
      }>`select token from executor_accounts where id = ${link!.account}`;
      assert.notEqual(link!.account, original!.id);
      assert.deepEqual(
        yield* Effect.promise(() => verifyPoolToken(Redacted.value(rotated), active!.token)),
        {
          pool: link!.app,
          owner: "person-a",
          organization,
        },
      );
      assert.equal((yield* sql`select * from executor_apps`).length, 1);
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
      assert.equal(
        (yield* sql`select id from executor_accounts where id = ${original!.id}`).length,
        0,
      );
      const [state] = yield* sql<{
        pool: { tokenKeyVersion: string; account: string };
      }>`select metadata::jsonb -> 'basaltPools' -> 'person-a' as pool from organization`;
      assert.equal(state!.pool.tokenKeyVersion, yield* poolTokenKeyVersion(rotated));
      assert.equal(state!.pool.account, link!.account);
    }),
  );
});

for (const drift of ["missing", "wrong creator", "wrong organization"] as const) {
  test(`a pool whose access record is ${drift} is listed again on the next reconcile`, async () => {
    await fixture(({ sql, setup }) =>
      Effect.gen(function* () {
        yield* setup();
        const [pool] = yield* sql<{ id: string }>`select id from executor_apps`;
        if (drift === "missing") yield* sql`delete from hosted_app_access where id = ${pool!.id}`;
        if (drift === "wrong creator")
          yield* sql`update hosted_app_access set creator_id = 'invited' where id = ${pool!.id}`;
        if (drift === "wrong organization")
          yield* sql`update hosted_app_access set organization_id = 'another-organization' where id = ${pool!.id}`;
        yield* setup();
        const rows =
          yield* sql`select organization_id, creator_id, audience from hosted_app_access where id = ${pool!.id}`;
        assert.deepEqual(rows, [
          { organization_id: organization, creator_id: "person-a", audience: "private" },
        ]);
        // Repeating the reconcile changes nothing and creates no second app.
        yield* setup();
        assert.equal(
          (yield* sql`select * from hosted_app_access where id = ${pool!.id}`).length,
          1,
        );
        assert.equal((yield* sql`select * from executor_apps`).length, 1);
      }),
    );
  });
}

test("an access repair rotates the record's revision and tells the pool Worker once", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const [pool] = yield* sql<{ id: string }>`select id from executor_apps`;
      yield* sql`update hosted_app_access set creator_id = 'invited', revision = 'old' where id = ${pool!.id}`;
      const changes: unknown[] = [];
      const recording = {
        appAccessChanged: (input: unknown) => Effect.sync(() => void changes.push(input)),
      };
      yield* setup().pipe(Effect.provideService(AccessLifecycle, recording));
      yield* setup().pipe(Effect.provideService(AccessLifecycle, recording));
      const [row] = yield* sql<{
        revision: string;
      }>`select revision from hosted_app_access where id = ${pool!.id}`;
      assert.notEqual(row!.revision, "old");
      assert.deepEqual(changes, [{ organization, apps: [pool!.id] }]);
    }),
  );
});

test("a pool the owner shared keeps its audience when its access record is repaired", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const [pool] = yield* sql<{ id: string }>`select id from executor_apps`;
      yield* sql`update hosted_app_access set audience = 'everyone', creator_id = 'invited' where id = ${pool!.id}`;
      yield* setup();
      const [row] =
        yield* sql`select creator_id, audience from hosted_app_access where id = ${pool!.id}`;
      assert.deepEqual(row, { creator_id: "person-a", audience: "everyone" });
    }),
  );
});

for (const failure of ["unlinked", "deleted", "invalid token", "wrong pool token"] as const) {
  test(`a current pool's ${failure} account is repaired without creating another app`, async () => {
    await fixture(({ sql, setup }) =>
      Effect.gen(function* () {
        yield* setup();
        const [old] = yield* sql`select id from executor_accounts`;
        if (failure === "unlinked") yield* sql`delete from hosted_app_account_links`;
        if (failure === "deleted") {
          yield* sql`delete from hosted_app_account_links`;
          yield* sql`delete from executor_accounts`;
        }
        if (failure === "wrong pool token") {
          const token = yield* Effect.promise(() =>
            signPoolToken(Redacted.value(key), {
              pool: "another-pool",
              owner: "person-a",
              organization,
            }),
          );
          yield* sql`update executor_accounts set token = ${token}`;
        }
        if (failure === "invalid token") yield* sql`update executor_accounts set token = 'broken'`;
        yield* setup();
        yield* setup();
        const [link] = yield* sql`select * from hosted_app_account_links`;
        const [account] = yield* sql<{
          token: string;
        }>`select token from executor_accounts where id = ${link!.account}`;
        assert.notEqual(link!.account, old!.id);
        assert.deepEqual(
          yield* Effect.promise(() => verifyPoolToken(Redacted.value(key), account!.token)),
          {
            pool: link!.app,
            owner: "person-a",
            organization,
          },
        );
        assert.equal((yield* sql`select * from executor_apps`).length, 1);
        assert.equal((yield* sql`select * from hosted_app_account_links`).length, 1);
        assert.equal((yield* sql`select * from executor_accounts`).length, 1);
        const [access] =
          yield* sql`select * from hosted_account_access where account_id = ${link!.account}`;
        assert.equal(access!.personal_user_id, "person-a");
      }),
    );
  });
}

test("key rotation and a missing link never recreate a deleted pool", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      yield* sql`delete from executor_apps`;
      yield* sql`delete from hosted_app_account_links`;
      const before = yield* sql`select * from organization`;
      const accounts = yield* sql`select * from executor_accounts`;
      yield* setup("person-a", Redacted.make("cd".repeat(32)));
      assert.equal((yield* sql`select * from executor_apps`).length, 0);
      assert.deepEqual(yield* sql`select * from organization`, before);
      assert.deepEqual(yield* sql`select * from executor_accounts`, accounts);
    }),
  );
});

test("pool copy origin reads the product name and falls back to upstream branding", async () => {
  const { ConfigProvider } = await import("effect");
  for (const name of ["Basalt", ""]) {
    await fixture(({ sql, setup }) =>
      Effect.gen(function* () {
        yield* setup().pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ EXECUTOR_PRODUCT_NAME: name }),
          ),
        );
        const [app] = yield* sql<{
          copied_from: { name: string };
        }>`select copied_from from executor_apps`;
        assert.equal(app!.copied_from.name, `${name || "Executor"} pool`);
      }),
    );
  }
});

test("a legacy unlinked pool deletes the personal account whose signed claims match", async () => {
  await fixture(({ sql, setup, executor }) =>
    Effect.gen(function* () {
      yield* setup();
      const [original] = yield* sql`select id from executor_accounts`;
      // Another app's token with the same provider and label must survive this repair unchanged.
      const token = yield* Effect.promise(() =>
        signPoolToken(Redacted.value(key), {
          pool: "another-pool",
          owner: "person-a",
          organization,
        }),
      );
      const unrelated = yield* lifecycleModule.personalAccountCreation("person-a")(
        executor.managedAccounts.add({
          owner: organizationContracts.organizationOwner(organization),
          provider: "provider-pool" as Account["provider"],
          method: "token",
          label: "Pool access",
          fields: Redacted.make({ token }),
        }),
      );
      yield* sql`update organization set metadata = (metadata::jsonb #- '{basaltPools,person-a,account}'
      #- '{basaltPools,person-a,tokenKeyVersion}')::text`;
      yield* sql`delete from hosted_app_account_links`;
      yield* setup();
      const [link] = yield* sql`select account from hosted_app_account_links`;
      assert.notEqual(link!.account, original!.id);
      assert.equal(
        (yield* sql`select id from executor_accounts where id = ${original!.id}`).length,
        0,
      );
      assert.equal(
        (yield* sql`select label from executor_accounts where id = ${unrelated.id}`)[0]!.label,
        "Pool access",
      );
    }),
  );
});

for (const transition of ["demotion", "email verification revoked"] as const) {
  const revoke = (sql: SqlClient.SqlClient) =>
    transition === "demotion"
      ? sql`update member set role = 'member' where "userId" = 'person-a'`
      : sql`update "user" set "emailVerified" = false where id = 'person-a'`;
  test(`${transition} during compilation prevents pool creation at commit`, async () => {
    await fixture(
      ({ sql, setup }) =>
        Effect.gen(function* () {
          assert.equal((yield* Effect.exit(setup()))._tag, "Failure");
          yield* setup();
          assert.equal((yield* sql`select * from executor_apps`).length, 0);
          assert.equal((yield* sql`select * from executor_accounts`).length, 0);
          assert.equal((yield* sql`select * from hosted_app_account_links`).length, 0);
        }),
      { beforeCopyCommit: revoke },
    );
  });
  test(`${transition} during compilation prevents upgrading an existing pool`, async () => {
    await fixture(
      ({ sql, setup }) =>
        Effect.gen(function* () {
          yield* setup();
          const old = JSON.stringify([{ path: "index.ts", content: "previous pool" }]);
          yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
        '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
          yield* sql`update executor_apps set files = ${old}::jsonb, workspace = ${old}::jsonb`;
          const before = yield* sql`select * from executor_apps`;
          const accounts = yield* sql`select * from executor_accounts`;
          assert.equal((yield* Effect.exit(setup()))._tag, "Failure");
          yield* setup();
          assert.deepEqual(yield* sql`select * from executor_apps`, before);
          assert.deepEqual(yield* sql`select * from executor_accounts`, accounts);
        }),
      { beforeDeployCommit: revoke },
    );
  });
}

for (const legacyUnlinked of [false, true]) {
  test(`a provider change repairs and deletes ${legacyUnlinked ? "a legacy unlinked" : "the recorded"} pool account`, async () => {
    await fixture(({ sql, setup, changeProvider }) =>
      Effect.gen(function* () {
        yield* setup();
        const [original] = yield* sql`select id from executor_accounts`;
        const old = JSON.stringify([{ path: "index.ts", content: "previous pool" }]);
        yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
      '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
        yield* sql`update executor_apps set files = ${old}::jsonb, workspace = ${old}::jsonb`;
        changeProvider();
        if (legacyUnlinked) {
          yield* sql`update organization set metadata = (metadata::jsonb #- '{basaltPools,person-a,account}'
          #- '{basaltPools,person-a,tokenKeyVersion}')::text`;
          yield* sql`delete from hosted_app_account_links`;
        }
        yield* setup();
        const [link] = yield* sql`select account from hosted_app_account_links`;
        const [account] =
          yield* sql`select provider from executor_accounts where id = ${link!.account}`;
        assert.equal(account!.provider, provisionedPoolProvider);
        assert.equal(
          (yield* sql`select id from executor_accounts where id = ${original!.id}`).length,
          0,
        );
        assert.equal((yield* sql`select * from executor_accounts`).length, 1);
      }),
    );
  });
}

test("a bundle upgrade re-mints and links the provisioned pool identity in the same job", async () => {
  await fixture(({ sql, executor, setup, changeProvider }) =>
    Effect.gen(function* () {
      yield* setup();
      const [appBefore] = yield* sql<{
        active_deployment: string;
      }>`select active_deployment from executor_apps`;
      const [oldAccount] = yield* sql<{
        id: string;
        provider: string;
        token: string;
      }>`select * from executor_accounts`;
      const oldFiles = JSON.stringify([{ path: "index.ts", content: "previous pool bundle" }]);
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
        '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
      yield* sql`update executor_apps set files = ${oldFiles}::jsonb, workspace = ${oldFiles}::jsonb`;
      changeProvider();
      yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id)
        values ('pool-bundle-upgrade', 'member', ${organization}, 'person-a')`;
      const initialize = yield* withPoolDefaults(executor, Option.some(key), () => Effect.void);

      const [line] = yield* reconcileLines(
        provision("pool-bundle-upgrade", selfHostProvisioningServices).pipe(
          Effect.provideService(OrganizationDefaults, initialize),
        ),
      );
      assert.deepEqual(line, {
        app: (yield* sql<{ id: string }>`select id from executor_apps`)[0]!.id,
        decision: "upgraded",
        accessRepaired: 0,
        tokenRepaired: true,
      });
      const [appAfter] = yield* sql<{
        active_deployment: string;
      }>`select active_deployment from executor_apps`;
      assert.notEqual(appAfter!.active_deployment, appBefore!.active_deployment);
      const [link] = yield* sql<{ account: string }>`select account from hosted_app_account_links`;
      assert.notEqual(link!.account, oldAccount!.id);
      const [current] = yield* sql<{
        provider: string;
        token: string;
      }>`select provider, token from executor_accounts where id = ${link!.account}`;
      assert.equal(current!.provider, provisionedPoolProvider);
      assert.deepEqual(
        yield* Effect.promise(() => verifyPoolToken(Redacted.value(key), current!.token)),
        {
          pool: (yield* sql<{ id: string }>`select id from executor_apps`)[0]!.id,
          owner: "person-a",
          organization,
        },
      );

      const rotated = Redacted.make("cd".repeat(32));
      yield* queuePoolAppUpgrades(rotated);
      const [rotation] = yield* sql<{
        id: string;
      }>`select id from hosted_provisioning where id like 'basalt-pool-token:%'`;
      assert.ok(rotation);
      yield* sql`update hosted_provisioning set available_at = now() where id = ${rotation!.id}`;
      const rotationInitialize = yield* withPoolDefaults(executor, Option.some(rotated), () =>
        Effect.die("token-only rotation must not run ordinary setup"),
      );
      yield* provision(rotation!.id, selfHostProvisioningServices).pipe(
        Effect.provideService(OrganizationDefaults, rotationInitialize),
      );
      const [rotatedLink] = yield* sql<{
        provider: string;
        token: string;
      }>`select a.provider, a.token
        from hosted_app_account_links l join executor_accounts a on a.id = l.account`;
      assert.equal(rotatedLink!.provider, provisionedPoolProvider);
      assert.ok(
        yield* Effect.promise(() => verifyPoolToken(Redacted.value(rotated), rotatedLink!.token)),
      );
    }),
  );
});

test("a member-job retry repairs a provisioned link after the bundle deploy commits", async () => {
  let injectFailure = true;
  let poolBundle = "previous-bundle";
  let poolFiles: SourceFiles = Schema.decodeUnknownSync(sdk.SourceFiles)([
    { path: "index.ts", content: "previous pool bundle" },
  ]);
  await fixture(
    ({ sql, executor, setup, changeProvider }) =>
      Effect.gen(function* () {
        yield* setup();
        const [before] = yield* sql<{
          id: string;
          active_deployment: string;
        }>`select id, active_deployment from executor_apps`;
        const [oldAccount] = yield* sql<{
          id: string;
          provider: string;
        }>`select id, provider from executor_accounts`;
        assert.equal(oldAccount!.provider, oldPoolProvider);
        poolBundle = "current-bundle";
        poolFiles = poolAppFiles;
        changeProvider();
        yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id)
          values ('pool-post-deploy-retry', 'member', ${organization}, 'person-a')`;
        const initialize = yield* withPoolDefaults(executor, Option.some(key), () => Effect.void);
        const job = () =>
          provision("pool-post-deploy-retry", selfHostProvisioningServices).pipe(
            Effect.provideService(OrganizationDefaults, initialize),
          );

        assert.equal((yield* Effect.exit(job()))._tag, "Failure");
        const [deployed] = yield* sql<{
          active_deployment: string;
        }>`select active_deployment from executor_apps`;
        assert.notEqual(deployed!.active_deployment, before!.active_deployment);
        const [failed] = yield* sql<{ status: string }>`select status from hosted_provisioning
          where id = 'pool-post-deploy-retry'`;
        assert.equal(failed!.status, "queued", "the failed member job remains retryable");
        const [oldLink] = yield* sql<{
          account: string;
          provider: string;
        }>`select l.account, a.provider
          from hosted_app_account_links l join executor_accounts a on a.id = l.account`;
        assert.equal(oldLink!.account, oldAccount!.id);
        assert.equal(oldLink!.provider, oldPoolProvider);

        const candidate = Schema.decodeUnknownSync(AccountId)("acc_guard_candidate");
        yield* sql`insert into executor_accounts values (
          ${candidate}, ${organizationContracts.organizationOwner(organization)},
          ${provisionedPoolProvider}, 'candidate token', 'token', 'candidate'
        )`;
        const guard = yield* Effect.match(
          linkAppAccount(executor, sql, {
            app: before!.id,
            requirement: "pool",
            account: candidate,
            linkedBy: "person-a",
          }),
          {
            onFailure: (error) => Schema.is(AccountProvisioned)(error),
            onSuccess: () => false,
          },
        );
        assert.equal(guard, true, "the shared link guard refuses replacing this provisioned link");

        const [line] = yield* reconcileLines(job());
        assert.deepEqual(line, {
          app: (yield* sql<{ id: string }>`select id from executor_apps`)[0]!.id,
          decision: "already-current",
          accessRepaired: 0,
          tokenRepaired: true,
        });
        const [repaired] = yield* sql<{ account: string; provider: string; token: string }>`
          select l.account, a.provider, a.token from hosted_app_account_links l
          join executor_accounts a on a.id = l.account`;
        assert.notEqual(repaired!.account, oldAccount!.id);
        assert.equal(repaired!.provider, provisionedPoolProvider);
        assert.deepEqual(
          yield* Effect.promise(() => verifyPoolToken(Redacted.value(key), repaired!.token)),
          {
            pool: (yield* sql<{ id: string }>`select id from executor_apps`)[0]!.id,
            owner: "person-a",
            organization,
          },
        );
        const [adopted] = yield* sql<{ version: string; bundle: string }>`select
          metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'version' as version,
          metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'bundle' as bundle
          from organization`;
        assert.equal(adopted!.version, deployed!.active_deployment);
        assert.equal(adopted!.bundle, "current-bundle");
        const [retried] = yield* sql<{ status: string }>`select status from hosted_provisioning
          where id = 'pool-post-deploy-retry'`;
        assert.equal(retried!.status, "succeeded");

        poolBundle = "next-pool-bundle";
        poolFiles = Schema.decodeUnknownSync(sdk.SourceFiles)([
          { path: "index.ts", content: "following pool bundle" },
        ]);
        yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id)
          values ('pool-following-bundle', 'member', ${organization}, 'person-a')`;
        const [followingLine] = yield* reconcileLines(
          provision("pool-following-bundle", selfHostProvisioningServices).pipe(
            Effect.provideService(OrganizationDefaults, initialize),
          ),
        );
        assert.deepEqual(followingLine, {
          app: before!.id,
          decision: "upgraded",
          accessRepaired: 0,
          tokenRepaired: false,
        });
        const [following] = yield* sql<{
          active_deployment: string;
        }>`select active_deployment from executor_apps`;
        assert.notEqual(following!.active_deployment, adopted!.version);
        const [followingRecord] = yield* sql<{ version: string; bundle: string }>`select
          metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'version' as version,
          metadata::jsonb -> 'basaltPools' -> 'person-a' ->> 'bundle' as bundle
          from organization`;
        assert.equal(followingRecord!.version, following!.active_deployment);
        assert.equal(followingRecord!.bundle, "next-pool-bundle");
      }),
    {
      poolSource: {
        get version() {
          return poolBundle;
        },
        files: Effect.sync(() => poolFiles),
      },
      afterDeployCommit: () => {
        if (!injectFailure) return Effect.void;
        injectFailure = false;
        return Effect.fail(new Error("injected failure after deploy commit"));
      },
    },
  );
});

test("rotation jobs wait 15 minutes for the pool Worker, including demoted and unverified holders", async () => {
  await fixture(({ sql, executor, setup }) =>
    Effect.gen(function* () {
      // Finish this bundle's delayed rollout before rotating its key.
      yield* queuePoolAppUpgrades(key);
      yield* sql`delete from hosted_provisioning`;
      yield* setup();
      yield* setup("person-b");
      yield* sql`update member set role = 'owner' where "userId" = 'invited'`;
      yield* setup("invited");
      const [deleted] =
        yield* sql`select app.id from executor_apps app join hosted_app_access access
      on access.id = app.id where access.creator_id = 'invited'`;
      yield* sql`delete from executor_apps where id = ${deleted!.id}`;
      const [deletedRecord] =
        yield* sql`select metadata::jsonb -> 'basaltPools' -> 'invited' as pool from organization`;
      yield* sql`update member set role = 'member' where "userId" = 'person-a'`;
      yield* sql`update member set role = 'admin' where "userId" = 'person-b'`;
      yield* sql`update "user" set "emailVerified" = false where id = 'person-b'`;
      const old = JSON.stringify([{ path: "index.ts", content: "retained pool source" }]);
      yield* sql`update executor_apps set files = ${old}::jsonb, workspace = ${old}::jsonb`;
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
      '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
      const apps = yield* sql`select * from executor_apps order by id`;
      const rotated = Redacted.make("cd".repeat(32));
      yield* queuePoolAppUpgrades(rotated);
      yield* queuePoolAppUpgrades(rotated);
      const jobs = yield* sql<{ id: string; user_id: string; delayed: boolean }>`select id, user_id,
      available_at > now() + interval '14 minutes' and available_at <= now() + interval '15 minutes' as delayed from hosted_provisioning order by user_id`;
      assert.deepEqual(
        jobs.map(({ user_id, delayed }) => ({ user_id, delayed })),
        [
          { user_id: "invited", delayed: true },
          { user_id: "person-a", delayed: true },
          { user_id: "person-b", delayed: true },
        ],
      );
      let ordinarySetupCalls = 0;
      const initialize = yield* withPoolDefaults(executor, Option.some(rotated), () =>
        Effect.sync(() => {
          ordinarySetupCalls++;
        }),
      );
      for (const job of jobs) {
        yield* sql`update hosted_provisioning set available_at = now() where id = ${job.id}`;
        yield* provision(job.id, {
          ...selfHostProvisioningServices,
          requireVerifiedEmail: true,
        }).pipe(Effect.provideService(OrganizationDefaults, initialize));
      }
      assert.equal(
        ordinarySetupCalls,
        0,
        "rotation jobs cannot invoke ordinary organization setup",
      );
      assert.deepEqual(yield* sql`select * from executor_apps order by id`, apps);
      assert.equal((yield* sql`select * from executor_accounts`).length, 3);
      const links = yield* sql<{
        token: string;
        personal_user_id: string;
        app: string;
      }>`select a.token,
      p.personal_user_id, l.app from hosted_app_account_links l
      join executor_accounts a on a.id = l.account join hosted_account_access p on p.account_id = a.id
      where l.app <> ${deleted!.id} order by p.personal_user_id`;
      for (const link of links) {
        assert.deepEqual(
          yield* Effect.promise(() => verifyPoolToken(Redacted.value(rotated), link.token)),
          {
            pool: link.app,
            owner: link.personal_user_id,
            organization,
          },
        );
      }
      assert.equal(links.length, 2);
      const [state] = yield* sql<{
        pools: Record<string, { tokenKeyVersion?: string; bundle?: string }>;
      }>`select
      metadata::jsonb -> 'basaltPools' as pools from organization`;
      const version = yield* poolTokenKeyVersion(rotated);
      assert.equal(state!.pools["person-a"]!.tokenKeyVersion, version);
      assert.equal(state!.pools["person-b"]!.tokenKeyVersion, version);
      assert.equal(state!.pools["person-a"]!.bundle, "previous-bundle");
      assert.deepEqual(state!.pools.invited, deletedRecord!.pool);
      // A fresh bundle retains its delay and only targets the remaining verified owner.
      yield* queuePoolAppUpgrades(rotated, "next-bundle");
      const delayed = yield* sql`select user_id from hosted_provisioning
      where available_at > now() + interval '14 minutes'`;
      assert.deepEqual(delayed, [{ user_id: "invited" }]);
    }),
  );
});

test("legacy completed rollout markers do not hide stale recorded tokens", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      yield* sql`update member set role = 'member' where "userId" = 'person-a'`;
      const rotated = Redacted.make("cd".repeat(32));
      const version = yield* poolTokenKeyVersion(rotated);
      yield* sql`insert into private_hosted_data_steps (name, run, mode, completed_at)
      values (${`basalt-pools:${poolAppVersion}:${version}`}, 'apply', 'apply', now())`;
      yield* queuePoolAppUpgrades(rotated);
      const rotation =
        yield* sql`select user_id, available_at > now() + interval '14 minutes' as delayed
        from hosted_provisioning where id like 'basalt-pool-token:%'`;
      assert.deepEqual(rotation, [{ user_id: "person-a", delayed: true }]);
    }),
  );
});

test("a stale key-version record rotates a demoted holder once even if its old token still verifies", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const [original] = yield* sql`select id from executor_accounts`;
      yield* sql`update member set role = 'member' where "userId" = 'person-a'`;
      yield* sql`update organization set metadata = (metadata::jsonb #- '{basaltPools,person-a,tokenKeyVersion}')::text`;
      yield* setup();
      yield* setup();
      const [link] = yield* sql`select account from hosted_app_account_links`;
      assert.notEqual(link!.account, original!.id);
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
      assert.equal((yield* sql`select * from executor_apps`).length, 1);
    }),
  );
});

test("returning to a previous signing key queues a fresh token-only rotation", async () => {
  await fixture(({ sql, executor, setup }) =>
    Effect.gen(function* () {
      yield* queuePoolAppUpgrades(key);
      yield* sql`delete from hosted_provisioning`;
      yield* setup();
      yield* sql`update member set role = 'member' where "userId" = 'person-a'`;
      const next = Redacted.make("cd".repeat(32));
      for (const signingKey of [next, key, next]) {
        yield* queuePoolAppUpgrades(signingKey);
        yield* queuePoolAppUpgrades(signingKey);
        const jobs = yield* sql<{
          id: string;
        }>`select id from hosted_provisioning where status = 'queued' and id like 'basalt-pool-token:%'`;
        assert.equal(jobs.length, 1);
        yield* sql`update hosted_provisioning set available_at = now() where id = ${jobs[0]!.id}`;
        const initialize = yield* withPoolDefaults(executor, Option.some(signingKey), () =>
          Effect.die("ordinary setup must not run"),
        );
        yield* provision(jobs[0]!.id, selfHostProvisioningServices).pipe(
          Effect.provideService(OrganizationDefaults, initialize),
        );
        const [linked] = yield* sql<{ token: string }>`select a.token from executor_accounts a
        join hosted_app_account_links l on l.account = a.id`;
        assert.ok(
          yield* Effect.promise(() => verifyPoolToken(Redacted.value(signingKey), linked!.token)),
        );
      }
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
      const [marker] =
        yield* sql`select pass from private_hosted_data_steps where name = 'basalt-pool-tokens'`;
      assert.equal(marker!.pass, 4);
    }),
  );
});

test("a recorded pool's job with nothing to do still logs its decision", async () => {
  await fixture(({ sql, executor, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const [app] = yield* sql<{ id: string }>`select id from executor_apps`;
      const initialize = yield* withPoolDefaults(executor, Option.some(key), () =>
        Effect.die("ordinary setup must not run"),
      );
      // The token is already on the current key, so a token-only job has nothing to rotate.
      yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id)
      values ('basalt-pool-token:current', 'member', ${organization}, 'person-a')`;
      assert.deepEqual(
        yield* reconcileLines(
          provision("basalt-pool-token:current", selfHostProvisioningServices).pipe(
            Effect.provideService(OrganizationDefaults, initialize),
          ),
        ),
        [{ app: app!.id, decision: "rotation-current", accessRepaired: 0, tokenRepaired: false }],
      );
      // A demoted holder's member job leaves the pool alone, and says so.
      yield* sql`update member set role = 'member' where "userId" = 'person-a'`;
      assert.deepEqual(yield* reconcileLines(setup()), [
        { app: app!.id, decision: "not-owner", accessRepaired: 0, tokenRepaired: false },
      ]);
    }),
  );
});

test("token-only jobs cannot create a pool for an unrecorded owner", async () => {
  await fixture(({ sql, executor }) =>
    Effect.gen(function* () {
      yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id)
      values ('basalt-pool-token:unrecorded', 'member', ${organization}, 'person-a')`;
      const initialize = yield* withPoolDefaults(executor, Option.some(key), () =>
        Effect.die("ordinary setup must not run"),
      );
      yield* provision("basalt-pool-token:unrecorded", selfHostProvisioningServices).pipe(
        Effect.provideService(OrganizationDefaults, initialize),
      );
      assert.equal((yield* sql`select * from executor_apps`).length, 0);
      assert.equal((yield* sql`select * from executor_accounts`).length, 0);
    }),
  );
});

test("an owner's token-only job preserves source until its bundle job runs", async () => {
  await fixture(({ sql, executor, setup }) =>
    Effect.gen(function* () {
      yield* queuePoolAppUpgrades(key);
      yield* sql`delete from hosted_provisioning`;
      yield* setup();
      const old = [{ path: "index.ts", content: "previous pool" }];
      yield* sql`update executor_apps set files = ${JSON.stringify(old)}::jsonb, workspace = ${JSON.stringify(old)}::jsonb`;
      yield* sql`update organization set metadata = jsonb_set(metadata::jsonb,
      '{basaltPools,person-a,bundle}', '"previous-bundle"')::text`;
      const rotated = Redacted.make("cd".repeat(32));
      yield* queuePoolAppUpgrades(rotated, "next-bundle");
      let ordinarySetupCalls = 0;
      const initialize = yield* withPoolDefaults(executor, Option.some(rotated), () =>
        Effect.sync(() => {
          ordinarySetupCalls++;
        }),
      );
      const [rotation] = yield* sql<{
        id: string;
      }>`select id from hosted_provisioning where id like 'basalt-pool-token:%'`;
      yield* sql`update hosted_provisioning set available_at = now() where id = ${rotation!.id}`;
      yield* provision(rotation!.id, selfHostProvisioningServices).pipe(
        Effect.provideService(OrganizationDefaults, initialize),
      );
      assert.equal(ordinarySetupCalls, 0);
      assert.deepEqual((yield* sql`select files from executor_apps`)[0]!.files, old);
      const [bundle] = yield* sql<{
        id: string;
      }>`select id from hosted_provisioning where user_id = 'person-a'
      and available_at > now() + interval '14 minutes'`;
      yield* sql`update hosted_provisioning set available_at = now() where id = ${bundle!.id}`;
      yield* provision(bundle!.id, selfHostProvisioningServices).pipe(
        Effect.provideService(OrganizationDefaults, initialize),
      );
      assert.equal(ordinarySetupCalls, 1);
      assert.deepEqual((yield* sql`select files from executor_apps`)[0]!.files, poolAppFiles);
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
    }),
  );
});

test("installs and upgrades use verified asset files; a current bundle never fetches the seed", async () => {
  const { createHash } = await import("node:crypto");
  const { makePoolAppSource } = await load(
    "apps/hosted/cloud/src/implementation/pool-app-assets.ts",
  );
  const first = [{ path: "index.ts", content: "first seed" }];
  const second = [{ path: "index.ts", content: "upgraded seed" }];
  const hash = (files: typeof first) =>
    createHash("sha256").update(JSON.stringify(files)).digest("hex");
  let firstReads = 0;
  let upgradeReads = 0;
  let fastReads = 0;
  const initial = makePoolAppSource(
    () =>
      Effect.sync(() => {
        firstReads++;
        return new Response(JSON.stringify(first));
      }),
    hash(first),
  );
  const upgrade = makePoolAppSource(
    () =>
      Effect.sync(() => {
        upgradeReads++;
        return new Response(JSON.stringify(second));
      }),
    hash(second),
  );
  const forbidden = makePoolAppSource(
    () =>
      Effect.sync(() => {
        fastReads++;
        throw new Error("fast path fetched");
      }),
    hash(second),
  );
  await fixture(
    ({ sql, executor, setup }) =>
      Effect.gen(function* () {
        yield* setup();
        assert.deepEqual((yield* sql`select files from executor_apps`)[0]!.files, first);
        assert.equal(firstReads, 1);
        yield* poolDefaults(executor, Option.some(key), organization, "person-a").pipe(
          Effect.provideService(PoolAppSource, upgrade),
        );
        assert.deepEqual((yield* sql`select files from executor_apps`)[0]!.files, second);
        assert.equal(upgradeReads, 1);
        yield* poolDefaults(executor, Option.some(key), organization, "person-a").pipe(
          Effect.provideService(PoolAppSource, forbidden),
        );
        assert.equal(fastReads, 0);
        assert.equal((yield* sql`select * from executor_apps`).length, 1);
        assert.equal((yield* sql`select * from executor_accounts`).length, 1);
      }),
    { poolSource: initial },
  );
});

test("a missing asset leaves member setup retryable and never deploys unverified source", async () => {
  const { makePoolAppSource } = await load(
    "apps/hosted/cloud/src/implementation/pool-app-assets.ts",
  );
  let reads = 0;
  const seed = makePoolAppSource(() =>
    Effect.sync(() =>
      ++reads === 1
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify(poolAppFiles)),
    ),
  );
  await fixture(
    ({ sql, executor }) =>
      Effect.gen(function* () {
        yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id)
      values ('seed-retry', 'member', ${organization}, 'person-a')`;
        const initialize = yield* withPoolDefaults(executor, Option.some(key), () => Effect.void);
        const run = provision("seed-retry", selfHostProvisioningServices).pipe(
          Effect.provideService(OrganizationDefaults, initialize),
        );
        assert.equal((yield* Effect.exit(run))._tag, "Failure");
        assert.equal((yield* sql`select * from executor_apps`).length, 0);
        assert.equal((yield* sql`select status from hosted_provisioning`)[0]!.status, "queued");
        yield* run;
        assert.equal(reads, 2);
        assert.equal((yield* sql`select * from executor_apps`).length, 1);
        assert.equal((yield* sql`select status from hosted_provisioning`)[0]!.status, "succeeded");
      }),
    { poolSource: seed },
  );
});

test("pool repair keeps a replaced account linked by another app", async () => {
  await fixture(({ sql, setup }) =>
    Effect.gen(function* () {
      yield* setup();
      const [original] = yield* sql`select id from executor_accounts`;
      yield* sql`insert into hosted_app_account_links values ('other-app', 'service', null, ${original!.id}, 'person-a', now())`;
      yield* setup("person-a", Redacted.make("cd".repeat(32)));
      assert.equal((yield* sql`select * from executor_accounts`).length, 2);
      assert.equal(
        (yield* sql`select label from executor_accounts where id = ${original!.id}`)[0]!.label,
        "Pool access (retired)",
      );
      assert.equal(
        (yield* sql`select * from hosted_app_account_links where app = 'other-app' and account = ${original!.id}`)
          .length,
        1,
      );
    }),
  );
});

test("retired pool cleanup journals deletion, keeps linked accounts and is idempotent", async () => {
  await fixture(({ sql, setup, executor }) =>
    Effect.gen(function* () {
      yield* setup();
      const [unlinked] = yield* sql`select id from executor_accounts`;
      yield* sql`delete from hosted_app_account_links`;
      yield* setup("person-b");
      const [linked] = yield* sql`select account from hosted_app_account_links`;
      yield* sql`update executor_accounts set label = 'Pool access (retired)'`;
      yield* cleanupRetiredPoolAccounts(executor);
      assert.equal(
        (yield* sql`select * from executor_accounts where id = ${unlinked!.id}`).length,
        0,
      );
      assert.equal(
        (yield* sql`select * from executor_accounts where id = ${linked!.account}`).length,
        1,
      );
      assert.equal(
        (yield* sql`select * from hosted_app_account_links where account = ${linked!.account}`)
          .length,
        1,
      );
      const journal =
        yield* sql`select * from private_hosted_data_steps where name = 'basalt-retired-pool-accounts'`;
      assert.equal(journal.length, 1);
      assert.ok(journal[0]!.completed_at);
      yield* cleanupRetiredPoolAccounts(executor);
      assert.deepEqual(
        yield* sql`select * from private_hosted_data_steps where name = 'basalt-retired-pool-accounts'`,
        journal,
      );
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
    }),
  );
});

test("retired pool cleanup rolls back its journal and deletion together on failure", async () => {
  await fixture(({ sql, setup, executor, failNextRemoval }) =>
    Effect.gen(function* () {
      yield* setup();
      yield* sql`delete from hosted_app_account_links`;
      yield* sql`update executor_accounts set label = 'Pool access (retired)'`;
      failNextRemoval();
      assert.equal((yield* Effect.exit(cleanupRetiredPoolAccounts(executor)))._tag, "Failure");
      assert.equal(
        (yield* sql`select * from private_hosted_data_steps where name = 'basalt-retired-pool-accounts'`)
          .length,
        0,
      );
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
      yield* cleanupRetiredPoolAccounts(executor);
      assert.equal((yield* sql`select * from executor_accounts`).length, 0);
    }),
  );
});

test("retired pool cleanup advances its cursor over bounded batches", async () => {
  await fixture(({ sql, setup, executor }) =>
    Effect.gen(function* () {
      yield* setup();
      const [original] = yield* sql`select * from executor_accounts`;
      yield* sql`delete from hosted_app_account_links`;
      yield* sql`delete from hosted_account_access`;
      yield* sql`delete from executor_accounts`;
      for (let index = 0; index < 101; index++) {
        const id = `acc_retired_${String(index).padStart(3, "0")}`;
        yield* sql`insert into executor_accounts values (${id}, ${original!.owner}, ${original!.provider}, ${original!.token}, 'token', 'Pool access (retired)')`;
        yield* sql`insert into hosted_account_access (account_id, organization_id, creator_id, kind, personal_user_id) values (${id}, ${organization}, 'person-a', 'personal', 'person-a')`;
      }
      yield* cleanupRetiredPoolAccounts(executor);
      assert.equal((yield* sql`select * from executor_accounts`).length, 1);
      assert.equal(
        (yield* sql`select completed_at from private_hosted_data_steps where name = 'basalt-retired-pool-accounts'`)[0]!
          .completed_at,
        null,
      );
      yield* cleanupRetiredPoolAccounts(executor);
      assert.equal((yield* sql`select * from executor_accounts`).length, 0);
      assert.ok(
        (yield* sql`select completed_at from private_hosted_data_steps where name = 'basalt-retired-pool-accounts'`)[0]!
          .completed_at,
      );
    }),
  );
});
