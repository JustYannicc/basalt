import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { defineProvider, oauth2, object, secrets, string } from "apps";
import { Crypto, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { cloudflareOAuthScopes } from "../../src/pool/provider-accounts/cloudflare-scopes.ts";
import { providers } from "../../src/pool/provider-accounts/definitions.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { providerDeclaration } from "../../.upstream/packages/apps/src/implementation/host.ts";
import { identifyProvider } from "../../.upstream/packages/sdk/src/implementation/provider.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { addLink } from "../../.upstream/apps/hosted/server/src/implementation/app-accounts.ts";
import { productionMigrations } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/migrations.ts";
import { runProductionOperation } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/runner.ts";
import { openArtifact } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts";
import { readOnly } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/read-only.ts";
import { checkPlanScope } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/scope.ts";

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
/** The catalog Cloudflare app's provider; its first published version discovered its scopes. */
const catalogCloudflare = (scopes?: readonly string[]) =>
  defineProvider({
    name: "Cloudflare",
    hosts: ["mcp.cloudflare.com", "api.cloudflare.com"],
    auth: {
      oauth: oauth2(scopes === undefined ? { discover: mcpUrl } : { discover: mcpUrl, scopes }),
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
const runnerTables = [
  'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
  "create table organization (id text primary key, metadata text)",
  "create table hosted_organization_removal (organization_id text)",
  "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text, created_at timestamptz)",
  "create table production_ops_database_identity (id uuid)",
  "insert into production_ops_database_identity values ('00000000-0000-4000-8000-000000000001')",
  "create table private_production_ops_receipts (plan_sha256 text primary key, organization_id text, migration text, revision text, release text, backup_sha256 text, verification jsonb, applied_at timestamptz default now())",
];

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* (yield* makeExecutorStorage({ provider: "postgresql" })).migrate;
  for (const ddl of runnerTables) yield* sql.unsafe(ddl);
  const first = yield* identify(catalogCloudflare());
  const current = yield* identify(catalogCloudflare(cloudflareOAuthScopes));
  const family = yield* identify(providers.cloudflare);
  const other = yield* identify(jira);
  // A deploy keeps an app's provider ref when a version only adds OAuth scopes, so the catalog
  // app still holds the ref its first definition derived. The stored row has its current definition.
  const retained = first.identity;
  yield* sql`insert into executor_providers (id,definition) values
    (${retained},${JSON.stringify(current.shared)}), (${family.identity},${JSON.stringify(family.shared)}),
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
  yield* deployment("dpl_tool_2", "code_tool", slot(retained, current.shared));
  // A second app copies the catalog app's current declaration, so it derives a fresh ref.
  yield* deployment("dpl_pipeline", "code_pipeline", slot(current.identity, current.shared));
  yield* sql`insert into executor_apps (id,code,owner,name,slug,active_deployment,created_at) values
    ('app_tool','code_tool',${owner},'Cloudflare','cloudflare','dpl_tool_2',now()),
    ('app_pipeline','code_pipeline',${owner},'Pipeline','pipeline','dpl_pipeline',now())`;
  yield* sql`insert into hosted_app_account_links values
    ('app_tool','cloudflare','user-a','acc_cloudflare','user-a',now())`;
  yield* sql`insert into executor_account_connections (id,owner,provider,reconnect_account,state,revision,oauth_attempt,created_at,expires_at,target)
    values ('con_cloudflare',${owner},${retained},null,${JSON.stringify({
      status: "completed",
      account: { id: "acc_cloudflare", owner, provider: retained, method: "apiToken" },
    })},'r1',null,now(),now(),${JSON.stringify({ app: "app_tool", requirement: "cloudflare" })})`;
  return {
    retained,
    current: current.identity,
    family: family.identity,
    other: other.identity,
  };
});

const webhooks = {
  sources: () => Effect.succeed([]),
  link: () => Effect.void,
  unlink: () => Effect.void,
};
/** `appAccounts.userLink` and `userLinkSource` write through this after their access checks. */
const link = (app: string, account: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        addLink(
          sql,
          webhooks as never,
          {
            app,
            requirement: "cloudflare",
            subject: "user-a",
            account,
            linkedBy: "user-a",
          } as never,
        ),
      )
      .pipe(
        Effect.as("linked"),
        Effect.catch((error) =>
          Effect.succeed(
            `${(error as { _tag?: string })._tag}:${(error as { reason?: string }).reason}`,
          ),
        ),
      );
  });
/** The accounts `appAccounts.userGet` lists for the requirement: its provider's saved accounts. */
const listed = (app: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ id: string }>`select a.id from executor_accounts a
      join executor_apps app on app.owner = a.owner
      join executor_deployments d on d.id = app.active_deployment
      where app.id = ${app}
        and a.provider = d.requirements::jsonb -> 'accounts' -> 'cloudflare' ->> 'provider'
      order by a.id`;
    return rows.map((row) => row.id);
  });

const recipient = generateKeyPairSync("rsa", { modulusLength: 3072 })
  .publicKey.export({ type: "spki", format: "der" })
  .toString("base64");
const settings = {
  target: "https://fixture.invalid",
  release: "fixture-release",
  databaseOrigin: { host: "fixture.invalid", port: 5432, database: "template1" },
  encryptionKey: "ab".repeat(32),
  preparations: {},
};
const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(work.pipe(Effect.provide(pgliteLayer())));

test("a Cloudflare account connected under the first catalog definition links to a second app after family adoption", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ids = yield* setup;
      assert.notEqual(ids.retained, ids.current, "the first definition derived another ref");
      assert.equal(ids.current, ids.family, "the catalog's declaration derives the family ref");
      // Existing app lineages keep their ref when this declaration changes, so a change needs an
      // explicit adoption of the refs it leaves behind before new apps can share those accounts.
      assert.equal(
        ids.family,
        "prv_723ba6038ee84547f30e619eae5d182081e413ff4088bf26c8d567c45facfa47",
        "the Cloudflare family's provider ref changed; ship an adoption for the previous ref",
      );
      assert.equal(yield* link("app_pipeline", "acc_cloudflare"), "RequirementMismatch:provider");
      assert.deepEqual(yield* listed("app_pipeline"), []);

      assert.ok(
        productionMigrations["cloudflare-family-adoption-v1"],
        "the Cloudflare family adoption is a registered production migration",
      );
      const reasons = yield* Effect.promise(
        () =>
          import("../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/migrations/cloudflare-family-adoption-v1.ts"),
      );
      const operator = yield* Effect.promise(
        () => import("../production-ops/cloudflare-family-adoption-reasons.ts"),
      );
      assert.deepEqual(
        operator.cloudflareFamilyAdoptionReasons,
        reasons.cloudflareFamilyAdoptionReasons,
        "the operator decodes every refusal reason the runtime reports",
      );
      const input = {
        action: "dry-run" as const,
        selection: "cloudflare-family-adoption-v1",
        recipient,
        request: {
          organization,
          from: ids.retained,
          to: ids.family,
          accounts: [{ account: "acc_cloudflare", generation: 3 }],
        },
      };
      const dry = yield* runProductionOperation(settings, input as never);
      assert.ok(dry.action === "dry-run");
      assert.equal(yield* link("app_pipeline", "acc_cloudflare"), "RequirementMismatch:provider");
      const reviewed = (yield* Effect.promise(() =>
        openArtifact(dry.artifact, settings.encryptionKey, settings.target),
      )) as { plan: { changes: { table: string; key: unknown; action: string }[]; data: unknown } };
      const plan = reviewed.plan;
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
      assert.deepEqual(
        (plan.data as { joining: unknown }).joining,
        [{ app: "app_pipeline", version: "dpl_pipeline" }],
        "the dry run names the apps that start offering the moved accounts",
      );
      assert.deepEqual(
        (plan.data as { apps: unknown }).apps,
        [{ app: "app_tool", version: "dpl_tool_2" }],
        "the dry run names the apps whose versions move",
      );
      const apply = {
        ...input,
        action: "apply" as const,
        artifact: dry.artifact,
        backupSha256: dry.backupSha256,
        planSha256: dry.artifact.sha256,
        go: `GO ${dry.artifact.sha256}`,
      };
      const outcome = yield* Effect.exit(runProductionOperation(settings, apply as never));
      const migration = productionMigrations["cloudflare-family-adoption-v1"]!;
      const direct = yield* Effect.exit(migration.verify(input.request, plan as never));
      const guarded = yield* Effect.exit(
        readOnly(
          checkPlanScope(plan as never, organization, "after").pipe(
            Effect.andThen(migration.verify(input.request, plan as never)),
          ),
        ),
      );
      assert.deepEqual({ direct, guarded }, {}, String(outcome._tag));
      const applied = yield* runProductionOperation(settings, apply as never);
      assert.ok(applied.action === "apply" && applied.repeated === false);

      assert.equal(yield* link("app_pipeline", "acc_cloudflare"), "linked");
      assert.deepEqual(yield* listed("app_pipeline"), ["acc_cloudflare"]);
      assert.deepEqual(yield* listed("app_tool"), ["acc_cloudflare"], "the catalog app keeps it");
      assert.deepEqual(
        yield* sql`select app, requirement, subject, account from hosted_app_account_links order by app`,
        [
          {
            app: "app_pipeline",
            requirement: "cloudflare",
            subject: "user-a",
            account: "acc_cloudflare",
          },
          {
            app: "app_tool",
            requirement: "cloudflare",
            subject: "user-a",
            account: "acc_cloudflare",
          },
        ],
      );
      assert.deepEqual(
        yield* sql`select id, provider, credential_generation from executor_accounts order by id`,
        [
          { id: "acc_cloudflare", provider: ids.family, credential_generation: 3 },
          { id: "acc_jira", provider: ids.other, credential_generation: 1 },
        ],
        "accounts keep their IDs and credentials; none is duplicated",
      );
      assert.equal(
        yield* link("app_pipeline", "acc_jira"),
        "RequirementMismatch:provider",
        "a different provider still refuses",
      );
      const replay = yield* runProductionOperation(settings, apply as never);
      assert.ok(replay.action === "apply" && replay.repeated === true, "replay verifies only");
      assert.equal((yield* sql`select * from private_production_ops_receipts`).length, 1);
    }),
  ));

test("family adoption refuses other providers, changed selections and work in progress", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
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
        to: ids.family,
        accounts: [{ account: "acc_cloudflare", generation: 3 }],
      };
      assert.equal(
        yield* refusal({
          ...base,
          from: ids.other,
          accounts: [{ account: "acc_jira", generation: 1 }],
        }),
        "retained-provider-not-family",
      );
      assert.equal(yield* refusal({ ...base, from: ids.family }), "already-family");
      assert.equal(yield* refusal({ ...base, to: ids.retained }), "family-ref-changed");
      assert.equal(
        yield* refusal({ ...base, accounts: [{ account: "acc_cloudflare", generation: 2 }] }),
        "account-set-changed",
      );
      yield* sql`insert into executor_account_acquisitions (account,owner,provider,method,driver,driver_revision,generation,revision)
        values ('acc_jira',${owner},${ids.retained},'apiToken','fixture','1',1,'r1')`;
      assert.equal(yield* refusal(base), "acquisition-outside-selection");
      yield* sql`delete from executor_account_acquisitions`;
      yield* sql`insert into executor_account_connections (id,owner,provider,reconnect_account,state,revision,oauth_attempt,created_at,expires_at,target)
        values ('con_pending',${owner},${ids.retained},null,${JSON.stringify({ status: "pending" })},'r1',null,now(),now() + interval '1 hour',${JSON.stringify({ app: "app_tool", requirement: "cloudflare" })})`;
      assert.equal(yield* refusal(base), "connection-in-progress");
    }),
  ));
