import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Effect, ErrorReporter, Logger } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const load = (path: string) => import(new URL(path, new URL(`file://${upstream}/`)).href);
const { StorageHost } = await load("packages/sdk/src/contracts/storage.ts");
const { VersionBuildFailed } = await load("packages/sdk/src/contracts/version.ts");
const { RuntimeBuildFailed } = await load("packages/sdk/src/contracts/runtime.ts");
const { versionBuildFailed } = await load(
  "packages/sdk/src/implementation/version-build-failure.ts",
);
const { ScheduleWakeup } = await load("apps/hosted/server/src/contracts/schedules.ts");
const { OrganizationDefaults } = await load(
  "apps/hosted/server/src/contracts/organization-defaults.ts",
);
const { CatalogAppSweep, catalogAppJobPrefix } = await load(
  "apps/hosted/server/src/contracts/catalog-app-updates.ts",
);
const { catalogAppDefaults } = await load(
  "apps/hosted/server/src/implementation/catalog-app-defaults.ts",
);
const { retryCompilerRequest } = await load(
  "apps/hosted/cloud/src/implementation/compiler-resource-retry.ts",
);
const { RpcCallError } = await import(
  new URL("../../.upstream/apps/hosted/cloud/node_modules/alchemy/lib/Rpc.js", import.meta.url).href
);

const { drainProvisioning } = await load("apps/hosted/server/src/implementation/provisioning.ts");

type File = { readonly path: string; readonly content: string };
type AppState = {
  readonly id: string;
  active: string;
  workspaceCommit: string;
  workspaceFiles: readonly File[];
  readonly versions: Map<string, readonly File[]>;
};
type CatalogRecordRow = { readonly apps: Readonly<Record<string, { readonly version?: string }>> };

const source = (version: number): readonly File[] => [
  { path: "index.ts", content: `export default ${version};\n` },
  {
    path: "package.json",
    content: '{"name":"@catalog/example","dependencies":{"apps":"1.0.0"}}\n',
  },
];
export const current = source(2);
const feedPackage = "@catalog/example";
export const version1 = "dpl_v1";
export const version2 = "dpl_v2";
export const job = `${catalogAppJobPrefix}${"a".repeat(40)}:00000000-0000-4000-8000-000000000001`;

const feedServer = async (entries: readonly string[]) => {
  const server = createServer((request, response) => {
    const id = request.url?.match(/^\/apps\/([^/]+)\.json$/u)?.[1];
    if (request.url === "/index.json") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          version: 1,
          apps: entries.map((entry) => ({
            id: entry,
            package: feedPackage,
            name: entry,
            description: "Synthetic catalog app",
            auth: [],
            icons: [],
            source: `apps/${entry}.json`,
          })),
        }),
      );
      return;
    }
    if (id !== undefined && entries.includes(id)) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ package: feedPackage, files: current }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/index.json`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

const fixture = (
  options: {
    readonly memoryFailures: number;
    readonly persistent?: boolean;
    readonly invalidSource?: boolean;
    readonly deploymentUnanswered?: boolean;
  },
  feedUrl: string,
) => {
  const apps = new Map<string, AppState>();
  for (const id of ["alpha", "beta"]) {
    const initial = source(1);
    apps.set(id, {
      id,
      active: version1,
      workspaceCommit: `${id}-c1`,
      workspaceFiles: initial,
      versions: new Map([[version1, initial]]),
    });
  }
  let memoryFailures = options.memoryFailures;
  let deploymentUnanswered = options.deploymentUnanswered ?? false;
  let compilerCalls = 0;
  let buildCalls = 0;
  const executor = {
    [StorageHost]: {
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect)),
      read: <A, E, R>(_tables: readonly string[], effect: Effect.Effect<A, E, R>) => effect,
      write: <A, E, R>(_tables: readonly string[], effect: Effect.Effect<A, E, R>) => effect,
    },
    apps: {
      list: () => Effect.succeed([...apps.values()].map((state) => app(state, feedUrl))),
      get: ({ app: id }: { app: string }) => Effect.sync(() => app(apps.get(id)!, feedUrl)),
      source: ({ app: id, version }: { app: string; version?: string }) =>
        Effect.sync(() => {
          const state = apps.get(id)!;
          const selected = version ?? state.active;
          return { id: selected, files: state.versions.get(selected)! };
        }),
      workspace: ({ app: id }: { app: string }) =>
        Effect.sync(() => {
          const state = apps.get(id)!;
          return {
            revision: { code: "fixture", commit: state.workspaceCommit },
            files: state.workspaceFiles,
          };
        }),
      versions: ({ app: id }: { app: string }) =>
        Effect.sync(() =>
          [...apps.get(id)!.versions.keys()].map((version, index) => ({
            id: version,
            createdAt: new Date(index),
          })),
        ),
      build: ({ app: id }: { app: string }) =>
        Effect.suspend(() => {
          buildCalls++;
          const request = Effect.tryPromise({
            try: async () => {
              compilerCalls++;
              if (id === "alpha" && (options.persistent || memoryFailures > 0)) {
                if (memoryFailures > 0) memoryFailures--;
                throw new Error("Worker exceeded memory limit");
              }
              return {
                requirements: {
                  accounts: {
                    crm: { provider: "provider-crm", scope: "user", cardinality: "one" },
                  },
                },
              };
            },
            catch: (cause) => new RpcCallError({ method: "compile", cause }),
          });
          return retryCompilerRequest(request).pipe(
            Effect.flatMap((result: unknown) => {
              if (id === "alpha" && options.invalidSource)
                return Effect.fail(
                  new VersionBuildFailed({
                    owner: "organization:team",
                    name: "alpha",
                    reason: "compile",
                    message: "The source does not compile.",
                  }),
                );
              return Effect.succeed(result);
            }),
          );
        }),
      deploy: ({
        app: id,
        files,
        expectedVersion,
      }: {
        app: string;
        files: readonly File[];
        expectedVersion?: string | null;
      }) =>
        Effect.suspend(() => {
          const state = apps.get(id)!;
          if (id === "alpha" && deploymentUnanswered) {
            deploymentUnanswered = false;
            return Effect.fail(
              versionBuildFailed(
                "organization:team",
                "alpha",
                new RuntimeBuildFailed({
                  stage: "compile",
                  message: "The compiler did not answer within its request budget.",
                  unanswered: true,
                }),
              ),
            );
          }
          if (expectedVersion !== undefined && state.active !== expectedVersion)
            return Effect.fail(new Error("Unexpected active version in fixture"));
          const version = `dpl_v${state.versions.size + 1}`;
          state.versions.set(version, files);
          state.active = version;
          return Effect.succeed({ app: app(state, feedUrl), version: { id: version } });
        }),
      commit: ({
        app: id,
        files,
        expected,
      }: {
        app: string;
        files: readonly File[];
        expected: string;
      }) =>
        Effect.sync(() => {
          const state = apps.get(id)!;
          if (state.workspaceCommit !== expected)
            throw new Error("Unexpected workspace revision in fixture");
          state.workspaceCommit = `${id}-c${state.versions.size}`;
          state.workspaceFiles = files;
          return {
            revision: { code: "fixture", commit: state.workspaceCommit },
            removed: { count: 0 },
          };
        }),
    },
  };
  return { executor, apps, counters: () => ({ compilerCalls, buildCalls }) };
};

const app = (state: AppState, feedUrl: string) => ({
  id: state.id,
  name: state.id,
  owner: "organization:team",
  activeVersion: state.active,
  copiedFrom: {
    reference: new URL(`apps/${state.id}.json`, feedUrl).href,
    name: state.id,
    commit: null,
  },
  requirements: {
    accounts: { crm: { provider: "provider-crm", scope: "user", cardinality: "one" } },
  },
});

export const withScenario = async (
  options: {
    readonly memoryFailures: number;
    readonly persistent?: boolean;
    readonly invalidSource?: boolean;
    readonly deploymentUnanswered?: boolean;
  },
  run: (scenario: {
    readonly execute: Effect.Effect<void, unknown, never>;
    readonly row: Effect.Effect<readonly Record<string, unknown>[], unknown, never>;
    readonly record: Effect.Effect<readonly CatalogRecordRow[], unknown, never>;
    readonly links: Effect.Effect<readonly Record<string, unknown>[], unknown, never>;
    readonly sql: SqlClient.SqlClient;
    readonly state: ReturnType<typeof fixture>;
    readonly incidents: unknown[];
    readonly logs: unknown[];
  }) => Effect.Effect<unknown, unknown, never>,
) => {
  const server = await feedServer(["alpha", "beta"]);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const client = yield* HttpClient.HttpClient;
          yield* sql`create table organization (id text primary key, metadata text not null default '{}')`;
          yield* sql`create table "user" (id text primary key, name text not null, "emailVerified" boolean not null)`;
          yield* sql`create table member ("organizationId" text not null, "userId" text not null, role text not null, "createdAt" timestamptz not null)`;
          yield* sql`create table hosted_provisioning (
        id text primary key, kind text not null, organization_id text not null, user_id text not null,
        status text not null default 'queued', attempts integer not null default 0,
        available_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
          yield* sql`create table executor_accounts (id text primary key, provider text not null)`;
          yield* sql`create table hosted_app_account_links (app text not null, requirement text not null, subject text, account text not null)`;
          yield* sql`insert into organization (id, metadata) values ('team', ${JSON.stringify({ basaltCatalogApps: Object.fromEntries(["alpha", "beta"].map((id) => [id, { version: version1, workspace: `${id}-c1` }])) })})`;
          yield* sql`insert into "user" values ('member-a', 'Member', true)`;
          yield* sql`insert into member values ('team', 'member-a', 'owner', now())`;
          yield* sql`insert into hosted_provisioning (id, kind, organization_id, user_id) values (${job}, 'member', 'team', 'member-a')`;
          const fixtureState = fixture(options, server.url);
          for (const appState of fixtureState.apps.values()) {
            yield* sql`insert into executor_accounts values (${`${appState.id}-account`}, 'provider-crm')`;
            yield* sql`insert into hosted_app_account_links values (${appState.id}, 'crm', 'member-a', ${`${appState.id}-account`})`;
          }
          const feed = {
            url: server.url,
            egress: { policy: { allowLoopbackHttp: true, allowedHttpOrigins: [] }, client },
          };
          const incidents: unknown[] = [];
          const logs: unknown[] = [];
          const initialize = (organization: string) =>
            Effect.gen(function* () {
              const catalogOnly = yield* CatalogAppSweep;
              logs.push(["initialize", catalogOnly]);
              if (catalogOnly) yield* catalogAppDefaults(fixtureState.executor, feed, organization);
            });
          const services = {
            requireVerifiedEmail: true,
            user: () => Effect.void,
            billing: () => Effect.void,
            domain: Effect.void,
          };
          const capture = Logger.make(({ message }) => logs.push(message));
          const runner = drainProvisioning(services).pipe(
            Effect.provideService(OrganizationDefaults, initialize),
            Effect.provideService(ScheduleWakeup, Effect.void),
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provide(Logger.layer([capture])),
          );
          const execute = runner.pipe(
            Effect.provide(
              ErrorReporter.layer([ErrorReporter.make(({ error }) => incidents.push(error))]),
            ),
          );
          yield* run({
            execute,
            row: sql`select status, attempts, available_at,
          extract(epoch from (available_at - updated_at)) as delay_seconds
          from hosted_provisioning where id = ${job}`,
            record: sql<CatalogRecordRow>`select metadata::jsonb -> 'basaltCatalogApps' as apps from organization where id = 'team'`,
            links: sql`select l.requirement, case when l.subject is null then 'app' else 'user' end as scope,
          l.subject, l.account, a.provider from hosted_app_account_links l
          join executor_accounts a on a.id = l.account where l.app = 'alpha'`,
            sql,
            state: fixtureState,
            incidents,
            logs,
          });
        }).pipe(Effect.provide(pgliteLayer()), Effect.provide(FetchHttpClient.layer)),
      ),
    );
  } finally {
    await server.close();
  }
};
