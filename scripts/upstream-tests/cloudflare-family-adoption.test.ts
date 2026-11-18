import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { defineProvider, oauth2, object, secrets, string } from "apps";
import { Crypto, Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";
import { providers } from "../../src/pool/provider-accounts/definitions.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { providerDeclaration } from "../../.upstream/packages/apps/src/implementation/host.ts";
import { identifyProvider } from "../../.upstream/packages/sdk/src/implementation/provider.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { productionMigrations } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/migrations.ts";

const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});
const identify = (provider: Parameters<typeof providerDeclaration>[0]) =>
  providerDeclaration(provider).pipe(
    Effect.flatMap((definition) => identifyProvider(definition, crypto)),
  );
const mcpUrl = "https://mcp.cloudflare.com/mcp";
/** The catalog Cloudflare app as first installed: sign-in discovered its scopes. */
const firstCloudflare = defineProvider({
  name: "Cloudflare",
  hosts: ["mcp.cloudflare.com", "api.cloudflare.com"],
  auth: {
    oauth: oauth2({ discover: mcpUrl }),
    apiToken: secrets({
      label: "User API token",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
    accountToken: secrets({
      label: "Account API token",
      fields: object({ accountId: string({ minLength: 1 }), token: string({ minLength: 1 }) }),
    }),
  },
});
const jira = defineProvider({
  name: "Jira",
  auth: { token: secrets({ label: "API token", fields: object({ token: string() }) }) },
});

const organization = "team-a";
const owner = `organization:${organization}`;
const slot = (provider: string, definition: unknown) => ({
  accounts: { cloudflare: { provider, scope: "user", cardinality: "many", definition } },
});

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* (yield* makeExecutorStorage({ provider: "postgresql" })).migrate;
  for (const ddl of [
    'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
    "create table organization (id text primary key, metadata text)",
    "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text, created_at timestamptz)",
  ])
    yield* sql.unsafe(ddl);
  const first = yield* identify(firstCloudflare);
  const family = yield* identify(providers.cloudflare);
  const other = yield* identify(jira);
  // A deploy keeps an app's provider ref when a version only adds OAuth scopes, so the catalog
  // app still holds the ref its first definition derived. The stored row has its current definition.
  const retained = first.identity;
  yield* sql`insert into executor_providers (id,definition) values
    (${retained},${JSON.stringify(family.shared)}), (${family.identity},${JSON.stringify(family.shared)}),
    (${other.identity},${JSON.stringify(other.shared)})`;
  yield* sql`insert into organization values (${organization},'{}')`;
  yield* sql`insert into member values ('member-a',${organization},'user-a','owner')`;
  yield* sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at,credential_generation)
    values ('acc_cloudflare',${owner},${retained},'apiToken','Cloudflare',${new Uint8Array([1])},now(),3),
      ('acc_jira',${owner},${other.identity},'token','Jira',${new Uint8Array([2])},now(),1)`;
  const deployment = (id: string, code: string, requirements: unknown) =>
    sql`insert into executor_deployments (id,code,owner,build,requirements,created_at,source_commit,file_count)
      values (${id},${code},${owner},${`bld_${id}`},${JSON.stringify(requirements)},now(),null,1)`;
  yield* deployment("dpl_tool_1", "code_tool", slot(retained, first.shared));
  yield* deployment("dpl_tool_2", "code_tool", slot(retained, family.shared));
  // A second app copies the current Cloudflare declaration and derives the family's identity.
  yield* deployment("dpl_pipeline", "code_pipeline", slot(family.identity, family.shared));
  yield* sql`insert into executor_apps (id,code,owner,name,slug,active_deployment,created_at) values
    ('app_tool','code_tool',${owner},'Cloudflare','cloudflare','dpl_tool_2',now()),
    ('app_pipeline','code_pipeline',${owner},'Pipeline','pipeline','dpl_pipeline',now())`;
  yield* sql`insert into hosted_app_account_links values
    ('app_tool','cloudflare','user-a','acc_cloudflare','user-a',now())`;
  yield* sql`insert into executor_account_connections (id,owner,provider,reconnect_account,state,revision,oauth_attempt,created_at,expires_at)
    values ('con_cloudflare',${owner},${retained},null,${JSON.stringify({
      status: "completed",
      account: { id: "acc_cloudflare", owner, provider: retained, method: "apiToken" },
    })},'r1',null,now(),now())`;
  return { retained, family: family.identity, other: other.identity };
});

/**
 * The provider condition `appAccounts.userLink` and `userLinkSource` apply before writing a link,
 * and the account list `userGet` offers: the requirement's provider in the app's active version
 * must be the account's provider.
 */
const linkable = (app: string, account: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ provider: string | null; accountProvider: string | null }>`select
        d.requirements::jsonb -> 'accounts' -> 'cloudflare' ->> 'provider' as provider,
        a.provider as "accountProvider"
      from executor_apps app
      left join executor_deployments d on d.id = app.active_deployment
      left join executor_accounts a on a.id = ${account} and a.owner = app.owner
      where app.id = ${app}`;
    const listed = yield* sql<{ id: string }>`select a.id from executor_accounts a
      join executor_apps app on app.owner = a.owner
      join executor_deployments d on d.id = app.active_deployment
      where app.id = ${app} and a.provider = d.requirements::jsonb -> 'accounts' -> 'cloudflare' ->> 'provider'`;
    const row = rows[0];
    return {
      link: row?.provider != null && row.provider === row.accountProvider,
      listed: listed.some((entry) => entry.id === account),
    };
  });

const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(work.pipe(Effect.provide(pgliteLayer())));

test("a Cloudflare account connected under the first catalog definition links to a second app after family adoption", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ids = yield* setup;
      assert.notEqual(ids.retained, ids.family, "the first definition derived another provider ref");
      assert.deepEqual(yield* linkable("app_tool", "acc_cloudflare"), { link: true, listed: true });
      assert.deepEqual(yield* linkable("app_pipeline", "acc_cloudflare"), {
        link: false,
        listed: false,
      });

      const migration = productionMigrations["cloudflare-family-adoption-v1"];
      assert.ok(migration, "the Cloudflare family adoption is a registered production migration");
      const request = {
        organization,
        from: ids.retained,
        accounts: [{ account: "acc_cloudflare", generation: 3 }],
        apps: [{ app: "app_tool", version: "dpl_tool_2" }],
      };
      const plan = yield* migration.inspect(request);
      assert.deepEqual(
        plan.changes.map((change) => [change.table, change.key, change.action]),
        [
          ["executor_accounts", { id: "acc_cloudflare" }, "update"],
          ["executor_deployments", { id: "dpl_tool_1" }, "update"],
          ["executor_deployments", { id: "dpl_tool_2" }, "update"],
          ["executor_account_connections", { id: "con_cloudflare" }, "update"],
        ],
        "only the retained ref's rows move; links, other providers and the second app stay",
      );
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* migration.lockAuthority?.(request, plan) ?? Effect.void;
          yield* migration.apply(request, plan);
        }),
      );
      const verified = yield* migration.verify(request, plan);
      assert.equal(verified.ok, true, JSON.stringify(verified.checks));

      assert.deepEqual(yield* linkable("app_pipeline", "acc_cloudflare"), {
        link: true,
        listed: true,
      });
      assert.deepEqual(
        yield* linkable("app_tool", "acc_cloudflare"),
        { link: true, listed: true },
        "the catalog app keeps its link",
      );
      assert.deepEqual(
        yield* sql`select app, requirement, subject, account from hosted_app_account_links`,
        [{ app: "app_tool", requirement: "cloudflare", subject: "user-a", account: "acc_cloudflare" }],
      );
      assert.deepEqual(
        yield* sql`select id, provider, credential_generation from executor_accounts order by id`,
        [
          { id: "acc_cloudflare", provider: ids.family, credential_generation: 3 },
          { id: "acc_jira", provider: ids.other, credential_generation: 1 },
        ],
        "accounts keep their IDs and credentials; none is duplicated",
      );
      assert.deepEqual(
        yield* linkable("app_pipeline", "acc_jira"),
        { link: false, listed: false },
        "a different provider still refuses",
      );
      assert.equal((yield* migration.verify(request, plan)).ok, true, "replay verifies");
      const again = yield* Effect.exit(migration.inspect(request));
      assert.ok(Exit.isFailure(again), "an applied adoption cannot plan again");
    }),
  ));

test("family adoption refuses a ref that is not the Cloudflare family or a changed account set", () =>
  run(
    Effect.gen(function* () {
      const ids = yield* setup;
      const migration = productionMigrations["cloudflare-family-adoption-v1"];
      assert.ok(migration, "the Cloudflare family adoption is a registered production migration");
      const refusal = (request: unknown) =>
        Effect.flip(migration.inspect(request as never)).pipe(
          Effect.map((error) => (error as { reasonCode?: string }).reasonCode),
        );
      const base = {
        organization,
        from: ids.retained,
        accounts: [{ account: "acc_cloudflare", generation: 3 }],
        apps: [{ app: "app_tool", version: "dpl_tool_2" }],
      };
      assert.equal(
        yield* refusal({ ...base, from: ids.other, accounts: [{ account: "acc_jira", generation: 1 }] }),
        "retained-provider-not-family",
      );
      assert.equal(yield* refusal({ ...base, from: ids.family }), "already-family");
      assert.equal(
        yield* refusal({ ...base, accounts: [{ account: "acc_cloudflare", generation: 2 }] }),
        "account-set-changed",
      );
      assert.equal(yield* refusal({ ...base, apps: [] }), "app-set-changed");
    }),
  ));
