import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineApp, defineProvider, oauth2, object, router, secrets, string } from "apps";
import { Crypto, Deferred, Effect, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { providers } from "../../src/pool/provider-accounts/definitions.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  createAppHandler,
  providerDeclaration,
} from "../../.upstream/packages/apps/src/implementation/host.ts";
import {
  BuiltApp,
  RuntimeBuildFailed,
} from "../../.upstream/packages/sdk/src/contracts/runtime.ts";
import { ProviderDefinition } from "../../.upstream/packages/sdk/src/contracts/provider.ts";
import { identifyProvider } from "../../.upstream/packages/sdk/src/implementation/provider.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";

// Cloud, hosted-server and SDK deploy modules load at runtime, as the other production-operations
// tests do, so root types never compile the whole hosted product.
const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
/** An upstream module, or undefined when the carried tree has no such file. */
export const loadOptional = (path: string): Promise<unknown> => load(path).catch(() => undefined);
/** A failure as the tests read it: its tag when it has one, its message and a refusal's code. */
type Failure = { readonly _tag?: string; readonly message: string; readonly reasonCode?: string };
/**
 * How the hosted modules loaded at runtime fail. Naming their own error unions would bring those
 * modules into root types. Each failure is an `Error`: most are tagged, a runner diagnostic is
 * not, and a reason is a string on a link refusal but an object on a database error.
 */
export type HostedFailure = Failure & { readonly reason?: unknown };
type Operated = {
  readonly action: string;
  readonly changes?: number;
  readonly artifact: { readonly sha256: string };
  readonly backupSha256: string;
  readonly repeated?: boolean;
};
export type Migration = {
  readonly inspect: (
    request: unknown,
  ) => Effect.Effect<unknown, HostedFailure, SqlClient.SqlClient>;
  readonly apply: (
    request: unknown,
    plan: unknown,
  ) => Effect.Effect<void, HostedFailure, SqlClient.SqlClient>;
};
export const { productionMigrations } = (await load(
  "apps/hosted/cloud/src/infrastructure/production-ops/migrations.ts",
)) as { productionMigrations: Readonly<Record<string, Migration | undefined>> };
const { runProductionOperation } = (await load(
  "apps/hosted/cloud/src/infrastructure/production-ops/runner.ts",
)) as {
  runProductionOperation: (
    settings: unknown,
    operation: unknown,
  ) => Effect.Effect<Operated, HostedFailure, SqlClient.SqlClient>;
};
const { openArtifact } = (await load(
  "apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts",
)) as { openArtifact: (artifact: unknown, key: string, target: string) => Promise<unknown> };
const { addLink } = (await load("apps/hosted/server/src/implementation/app-accounts.ts")) as {
  addLink: (
    sql: SqlClient.SqlClient,
    webhooks: unknown,
    input: unknown,
  ) => Effect.Effect<boolean, HostedFailure, SqlClient.SqlClient>;
};
type Deployed = {
  readonly app: { readonly id: string };
  readonly version: { readonly id: string };
};
type Apps = {
  readonly deploy: (input: unknown) => Effect.Effect<Deployed, HostedFailure, SqlClient.SqlClient>;
};
const { makeApps } = (await load("packages/sdk/src/implementation/apps.ts")) as {
  makeApps: (...dependencies: unknown[]) => Apps;
};
const { database } = (await load("packages/sdk/src/implementation/database.ts")) as {
  database: (storage: unknown) => unknown;
};
const { gitSourceStorage } = (await load("packages/sdk/src/implementation/git-sources.ts")) as {
  gitSourceStorage: (repositories: unknown) => unknown;
};
const { memoryRegistry, memoryRepositories } = (await load("packages/sdk/src/testing.ts")) as {
  memoryRegistry: () => unknown;
  memoryRepositories: () => unknown;
};

const digest = (data: Uint8Array) => new Uint8Array(createHash("sha256").update(data).digest());
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
  digest: (_algorithm, data) => Effect.succeed(digest(data)),
});
export const identify = (provider: Parameters<typeof providerDeclaration>[0]) =>
  providerDeclaration(provider).pipe(
    Effect.flatMap((definition) => identifyProvider(definition, crypto)),
  );

/** The identity of a provider definition as a deploy stored it. */
export const identifyStored = (definition: unknown) =>
  Schema.decodeUnknownEffect(ProviderDefinition)(definition).pipe(
    Effect.flatMap((decoded) => identifyProvider(decoded, crypto)),
  );

export type Files = readonly { readonly path: string; readonly content: string }[];
/** The catalog Cloudflare app: its first published source, and the current one with every scope. */
export const catalogSource = (name: "cloudflare.published" | "cloudflare"): Files =>
  (
    JSON.parse(
      readFileSync(new URL(`../../src/catalog/${name}.json`, import.meta.url), "utf8"),
    ) as { files: Files }
  ).files;
/** The provider a catalog source declares, evaluated from its own text. Its health check never runs. */
export const catalogProvider = (files: Files) => {
  const source = (path: string) => files.find((file) => file.path === path)?.content ?? "";
  const index = source("index.ts");
  const start = index.indexOf("defineProvider(");
  let end = start + "defineProvider".length;
  for (let depth = 0; end < index.length; end++) {
    if (index[end] === "(") depth++;
    if (index[end] === ")" && --depth === 0) break;
  }
  const mcpUrl = /const mcpUrl = "([^"]+)";/u.exec(index)?.[1];
  assert.ok(start > 0 && end < index.length && mcpUrl, "the catalog source declares its provider");
  const scopes = (source("cloudflare-scopes.ts").match(/"[^"]+"/gu) ?? []).map(
    (quoted) => JSON.parse(quoted) as string,
  );
  const declare = new Function(
    "defineProvider",
    "oauth2",
    "object",
    "secrets",
    "string",
    "mcpUrl",
    "cloudflareOAuthScopes",
    `return ${index.slice(start, end + 1)};`,
  ) as (...values: unknown[]) => ReturnType<typeof defineProvider>;
  return declare(defineProvider, oauth2, object, secrets, string, mcpUrl, scopes);
};
/** The requirements the app host declares for an app with this one Cloudflare slot. */
const declared = (files: Files) =>
  Effect.gen(function* () {
    const provider = catalogProvider(files);
    const app = defineApp({ user: { accounts: { cloudflare: provider.many() } } }, async () => ({
      tools: router({}),
    }));
    const response = yield* createAppHandler(app)(
      new Request("https://app.invalid/", {
        method: "POST",
        body: JSON.stringify({ operation: "requirements" }),
      }),
      { accounts: Redacted.make({ app: {} }) },
    );
    const reply = (yield* Effect.promise(() => response.json())) as { ok: boolean; value: unknown };
    assert.ok(reply.ok, "the app host declares the app's requirements");
    return reply.value;
  });

export type Hold = {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<"built" | "failed">;
};
/** Builds answer as the runtime does; a held build waits until the test releases it. */
const fixtureRuntime = (holds: Hold[]) => {
  let builds = 0;
  return {
    build: (input: { readonly files: Files }) =>
      Effect.gen(function* () {
        const hold = holds.shift();
        if (hold !== undefined) {
          yield* Deferred.succeed(hold.reached, undefined);
          if ((yield* Deferred.await(hold.release)) === "failed")
            return yield* new RuntimeBuildFailed({ stage: "source", message: "Fixture failure" });
        }
        builds += 1;
        return yield* Schema.decodeUnknownEffect(BuiltApp)({
          build: `bld_fixture${builds}`,
          requirements: yield* declared(input.files),
        });
      }),
    migrate: () => Effect.die("No fixture app declares SQL"),
  };
};
const memoryBlobs = () => {
  const objects = new Map<string, Uint8Array>();
  return {
    get: (key: string) => Effect.sync(() => Option.fromNullishOr(objects.get(key))),
    exists: (key: string) => Effect.sync(() => objects.has(key)),
    put: (key: string, body: Uint8Array) => Effect.sync(() => void objects.set(key, body)),
    remove: (key: string) => Effect.sync(() => void objects.delete(key)),
    list: () => Effect.succeed({ names: [], truncated: false }),
    stream: () => Effect.die("No fixture streams a blob"),
  };
};

const jira = defineProvider({
  name: "Jira",
  auth: { token: secrets({ label: "API token", fields: object({ token: string() }) }) },
});
export const teamA = "team-a";
export const teamB = "team-b";
export const ownerOf = (organization: string) => `organization:${organization}`;
const runnerTables = [
  'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
  "create table organization (id text primary key, metadata text)",
  "create table hosted_organization_removal (organization_id text)",
  "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text, created_at timestamptz)",
  "create table hosted_account_access (account_id text primary key, organization_id text, kind text, personal_user_id text, audience text)",
  // The provisioning queue's columns, without its team and member triggers.
  "create table hosted_provisioning (id text primary key, kind text not null, organization_id text, user_id text, status text not null default 'queued', attempts integer not null default 0, available_at timestamptz not null default now(), updated_at timestamptz not null default now())",
  "create table production_ops_database_identity (id uuid)",
  "insert into production_ops_database_identity values ('00000000-0000-4000-8000-000000000001')",
  "create table private_production_ops_receipts (plan_sha256 text primary key, organization_id text, migration text, revision text, release text, backup_sha256 text, verification jsonb, applied_at timestamptz default now())",
];
/** Every table the adoption reads or writes, and every row an account keeps beside it. */
export const watchedTables = [
  "organization",
  "member",
  "executor_providers",
  "executor_accounts",
  "executor_account_identities",
  "executor_oauth_grants",
  "executor_apps",
  "executor_deployments",
  "executor_account_connections",
  "executor_account_acquisitions",
  "executor_stored_oauth_clients",
  "executor_stored_oauth_client_credentials",
  "hosted_app_account_links",
  "hosted_account_access",
  "hosted_provisioning",
  "private_production_ops_receipts",
] as const;

const webhooks = {
  sources: () => Effect.succeed([]),
  link: () => Effect.void,
  unlink: () => Effect.void,
};
/** `appAccounts.userLink` and `userLinkSource` write through this after their access checks. */
export const link = (app: string, account: string, subject = "user-a") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        addLink(sql, webhooks, {
          app,
          requirement: "cloudflare",
          subject,
          account,
          linkedBy: subject,
        }),
      )
      .pipe(
        Effect.as("linked"),
        Effect.catch((error) => Effect.succeed(`${error._tag}:${error.reason}`)),
      );
  });
/** The provider filter `appAccounts.userGet` lists a requirement's saved accounts with. */
export const listed = (app: string) =>
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

/**
 * Two organizations installed the catalog Cloudflare app with an earlier declaration (`published`;
 * `world` uses the first published source) and then received the current one, which only adds
 * scopes, through the real deploy path. Team A also runs
 * a second app declaring the current provider. Accounts, links and connections are the rows the
 * sign-in and link flows write: an API-token account with credential generation 3 and an OAuth
 * account with its identity and grant in team A, a Jira account, and one API-token account in team B.
 */
export const worldFrom = (published: Files) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* storage.migrate;
    for (const ddl of runnerTables) yield* sql.unsafe(ddl);
    const holds: Hold[] = [];
    const repositories = memoryRepositories();
    const apps = makeApps(
      database(storage),
      fixtureRuntime(holds),
      crypto,
      gitSourceStorage(repositories),
      repositories,
      memoryRegistry(),
      memoryBlobs(),
    );
    const current = catalogSource("cloudflare");
    const install = (organization: string, name: string, files: Files) =>
      apps.deploy({ owner: ownerOf(organization), name, files });
    const redeploy = (organization: string, app: string, files = current) =>
      apps.deploy({ owner: ownerOf(organization), app, files });

    const toolA = yield* install(teamA, "Cloudflare", published);
    const scopesA = yield* redeploy(teamA, toolA.app.id);
    const pipeline = yield* install(teamA, "Pipeline", current);
    const toolB = yield* install(teamB, "Cloudflare", published);
    const scopesB = yield* redeploy(teamB, toolB.app.id);

    const requirement = (version: string) =>
      sql<{
        provider: string;
      }>`select requirements::jsonb -> 'accounts' -> 'cloudflare' ->> 'provider' as provider
      from executor_deployments where id = ${version}`.pipe(
        Effect.map((rows) => rows[0]!.provider),
      );
    const retained = yield* requirement(scopesA.version.id);
    const family = yield* requirement(pipeline.version.id);
    const other = yield* identify(jira);
    yield* sql`insert into executor_providers (id,definition) values (${other.identity},${JSON.stringify(other.shared)})`;
    yield* sql`insert into organization values (${teamA},'{}'), (${teamB},'{}')`;
    yield* sql`insert into member values ('member-a',${teamA},'user-a','owner'),
    ('member-b',${teamA},'user-b','member'), ('member-c',${teamB},'user-c','owner')`;
    const account = (
      id: string,
      organization: string,
      provider: string,
      method: string,
      generation: number,
      oauth?: { identity: string; grant: string },
    ) =>
      sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at,credential_generation,identity_id,oauth_grant_id)
      values (${id},${ownerOf(organization)},${provider},${method},${id},${new Uint8Array(digest(new TextEncoder().encode(id)))},now(),${generation},${oauth?.identity ?? null},${oauth?.grant ?? null})`;
    yield* account("acc_token", teamA, retained, "apiToken", 3);
    yield* account("acc_oauth", teamA, retained, "oauth", 1, {
      identity: "aid_oauth",
      grant: "grt_oauth",
    });
    yield* account("acc_jira", teamA, other.identity, "token", 1);
    yield* account("acc_team_b", teamB, retained, "apiToken", 1);
    yield* sql`insert into executor_account_identities (id,owner,placement,issuer,subject,name,label,verified_at,created_at)
    values ('aid_oauth',${ownerOf(teamA)},${JSON.stringify([teamA, "personal", "user-b", null, []])},
      'https://dash.cloudflare.com','cf-user-b','User B','user-b@example.invalid',now(),now())`;
    yield* sql`insert into executor_oauth_grants (id,encrypted,status,updated_at,owner)
    values ('grt_oauth',${new Uint8Array([7])},'active',now(),${ownerOf(teamA)})`;
    yield* sql`insert into hosted_account_access values
    ('acc_token',${teamA},'personal','user-a',null), ('acc_oauth',${teamA},'personal','user-b',null),
    ('acc_jira',${teamA},'personal','user-a',null), ('acc_team_b',${teamB},'personal','user-c',null)`;
    for (const [app, account, subject] of [
      [toolA.app.id, "acc_token", "user-a"],
      [toolA.app.id, "acc_oauth", "user-b"],
      [toolB.app.id, "acc_team_b", "user-c"],
    ] as const)
      assert.equal(yield* link(app, account, subject), "linked");
    const connection = (
      id: string,
      organization: string,
      provider: string,
      app: string,
      account: string,
      method: string,
    ) =>
      sql`insert into executor_account_connections (id,owner,provider,reconnect_account,state,revision,oauth_attempt,created_at,expires_at,target)
      values (${id},${ownerOf(organization)},${provider},null,${JSON.stringify({
        status: "completed",
        account: { id: account, owner: ownerOf(organization), provider, method },
      })},'r1',null,now(),now(),${JSON.stringify({ app, requirement: "cloudflare" })})`;
    yield* connection("con_token", teamA, retained, toolA.app.id, "acc_token", "apiToken");
    yield* connection("con_team_b", teamB, retained, toolB.app.id, "acc_team_b", "apiToken");
    const acquisition = (account: string, organization: string) =>
      sql`insert into executor_account_acquisitions (account,owner,provider,method,driver,driver_revision,generation,revision)
      values (${account},${ownerOf(organization)},${retained},'oauth','fixture','1',1,'r1')`;
    yield* acquisition("acc_oauth", teamA);
    yield* acquisition("acc_team_b", teamB);

    return {
      apps,
      holds,
      install,
      redeploy,
      requirement,
      retained,
      family,
      other: other.identity,
      toolA: toolA.app.id,
      toolB: toolB.app.id,
      pipeline: pipeline.app.id,
      versionsA: [toolA.version.id, scopesA.version.id],
      versionsB: [toolB.version.id, scopesB.version.id],
      pipelineVersion: pipeline.version.id,
      /** Team A's exact selection: every account still under the retained ref, with its generation. */
      requestA: {
        organization: teamA,
        from: retained,
        to: family,
        accounts: [
          { account: "acc_oauth", generation: 1 },
          { account: "acc_token", generation: 3 },
        ],
      },
      requestB: {
        organization: teamB,
        from: retained,
        to: family,
        accounts: [{ account: "acc_team_b", generation: 1 }],
      },
    };
  });
export const world = worldFrom(catalogSource("cloudflare.published"));
export type World = Effect.Success<typeof world>;

/** Hold the next build until the returned release is completed. */
export const holdNextBuild = (holds: Hold[]) =>
  Effect.gen(function* () {
    const hold: Hold = {
      reached: yield* Deferred.make<void>(),
      release: yield* Deferred.make<"built" | "failed">(),
    };
    holds.push(hold);
    return hold;
  });

const recipient = generateKeyPairSync("rsa", { modulusLength: 3072 })
  .publicKey.export({ type: "spki", format: "der" })
  .toString("base64");
export const settings = {
  target: "https://fixture.invalid",
  release: "fixture-release",
  databaseOrigin: { host: "fixture.invalid", port: 5432, database: "template1" },
  encryptionKey: "ab".repeat(32),
  preparations: {},
};
export const selection = "cloudflare-family-adoption-v1";
export type Plan = {
  readonly changes: readonly { table: string; key: unknown; action: string }[];
  readonly data: {
    readonly apps: unknown;
    readonly joining: unknown;
    readonly links: unknown;
    readonly accounts: unknown;
    readonly deployments: unknown;
  };
};
export const dryRun = (request: unknown) =>
  Effect.gen(function* () {
    const operation = { action: "dry-run" as const, selection, recipient, request };
    const dry = yield* runProductionOperation(settings, operation);
    const reviewed = (yield* Effect.promise(() =>
      openArtifact(dry.artifact, settings.encryptionKey, settings.target),
    )) as { plan: Plan };
    const go = {
      ...operation,
      action: "apply" as const,
      artifact: dry.artifact,
      backupSha256: dry.backupSha256,
      planSha256: dry.artifact.sha256,
      go: `GO ${dry.artifact.sha256}`,
    };
    return { dry, plan: reviewed.plan, go };
  });
export const apply = (go: unknown) => runProductionOperation(settings, go);
/** The refusal reason an operation failed with, or what it returned instead. */
export const reasonOf = <A, E extends Failure>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  work.pipe(
    Effect.map(() => "succeeded"),
    Effect.catch((error) => Effect.succeed(error.reasonCode ?? `${error._tag}: ${error.message}`)),
  );
/** Every watched table's rows, so a comparison shows every row that changed. */
export const everything = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables: Record<string, string[]> = {};
  for (const table of watchedTables) {
    const rows = yield* sql.unsafe<{ row: unknown }>(
      `select to_jsonb(entry) as row from "${table}" entry`,
    );
    tables[table] = rows.map(({ row }) => JSON.stringify(row)).sort();
  }
  return tables;
});
/** Rows of `before` that differ in `after`, by table, as their parsed before and after values. */
export const changed = (before: Record<string, string[]>, after: Record<string, string[]>) =>
  Object.fromEntries(
    watchedTables.flatMap((table) => {
      const gone = before[table]!.filter((row) => !after[table]!.includes(row));
      const added = after[table]!.filter((row) => !before[table]!.includes(row));
      return gone.length === 0 && added.length === 0
        ? []
        : [
            [
              table,
              {
                gone: gone.map((row) => JSON.parse(row)),
                added: added.map((row) => JSON.parse(row)),
              },
            ],
          ];
    }),
  ) as Record<string, { gone: Record<string, unknown>[]; added: Record<string, unknown>[] }>;
export const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(work.pipe(Effect.provide(pgliteLayer())));
export { providers };
