import { createHash } from "node:crypto";
import { Crypto, Effect, Option, Redacted } from "effect";
import { poolAccountAcquisition } from "../../.upstream/apps/hosted/server/src/implementation/pool-account-acquisition.ts";
import { providerFixtureApps } from "./provider-destinations-apps.ts";
import { providerApps } from "../../src/catalog/provider-apps/index.ts";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  authorization,
  CurrentAuthorization,
  CurrentOrganization,
  CurrentUserId,
  GroupDatabase,
  HostedCatalog,
  HostedExecutor,
  methods,
  sdk,
  type App,
  type AppId,
  type Executor,
} from "./provider-destinations-modules.ts";

type Services = Effect.Services<ReturnType<typeof methods.providerAccountMethodView>>;
export type Reads = Record<
  "apps" | "catalog" | "installs" | "accesses" | "pool" | "checked",
  number
>;
export const emptyReads = (): Reads => ({
  apps: 0,
  catalog: 0,
  installs: 0,
  accesses: 0,
  pool: 0,
  checked: 0,
});
export type Fixture = {
  app: App;
  listed: App[];
  reads: Reads;
  reset: () => void;
  setCatalog: (state: "normal" | "empty" | "failed") => void;
  sql: SqlClient.SqlClient;
};

export const fixture = <A, E>(
  run: (fixture: Fixture) => Effect.Effect<A, E, Services>,
  options: {
    manage?: boolean;
    pool?: boolean;
    restricted?: boolean;
    catalog?: boolean;
    shape?: "mixed" | "literal";
    native?: boolean;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const native = yield* SqlClient.SqlClient;
      const reads = emptyReads();
      let catalogState = "normal";
      const read = (key: keyof Reads) =>
        Effect.sync(() => {
          reads[key]++;
        });
      // These policy/install functions have no injectable service, so count their SQL at the database seam.
      const sql = new Proxy(native, {
        apply(target, receiver, args) {
          const statement = Reflect.apply(target, receiver, args);
          const text = Array.isArray(args[0]) ? args[0].join("?") : "";
          const key = text.includes("as service")
            ? "installs"
            : text.includes("select p.id as app")
              ? "accesses"
              : text.includes("select a.id from organization")
                ? "pool"
                : text.includes("select m.id, m.role")
                  ? "checked"
                  : undefined;
          return key === undefined ? statement : Effect.andThen(read(key), statement);
        },
      });
      const crypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) =>
          Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
      });
      const { app, listed, accounts, definitions, organization, owner } =
        yield* providerFixtureApps(options.pool !== false, options.shape).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        );
      for (const statement of [
        "create table organization (id text primary key, metadata text)",
        'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
        "create table executor_apps (id text primary key, owner text)",
        "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
        "create table hosted_app_groups (app_id text, group_id text)",
        "create table hosted_group_members (group_id text, member_id text)",
      ])
        yield* native.unsafe(statement);
      yield* native`insert into organization values (${organization}, ${JSON.stringify({
        basaltPools: options.pool === false ? {} : { person: { app: app.id } },
        basaltServiceInstalls: {
          app_recorded: { id: "fixture-openai-service", newInstance: false },
        },
      })})`;
      yield* native`insert into member values ('member-person', ${organization}, 'person', 'member')`;
      for (const candidate of [app, ...listed]) {
        yield* native`insert into executor_apps values (${candidate.id}, ${owner})`;
        const hidden = candidate.id.includes("hidden");
        const creator =
          candidate.id === app.id || candidate.id.includes("openai") ? "person" : "other";
        yield* native`insert into hosted_app_access values (${candidate.id}, ${organization}, ${creator}, ${hidden ? "private" : "everyone"}, 'revision-1')`;
      }
      const entries = [...definitions.keys()]
        .filter((family) =>
          options.native
            ? providerApps.some((app) => app.entry.id === `provider-${family}`)
            : family !== "iflow",
        )
        .map((family) => ({
          id: `provider-${family}`,
          package: `fixture-${family}`,
          name: family,
          description: "",
          auth: [],
          icons: [],
          ...(family === "openai"
            ? {
                service: {
                  id: "fixture-openai-service",
                  newInstance: false,
                  packages: ["fixture-openai"],
                },
              }
            : {}),
        }));
      const permitted = [app, ...listed.filter((candidate) => candidate.id !== "app_gemini")].map(
        (candidate) => candidate.id,
      );
      const policy = options.restricted
        ? authorization.selectedAuthority(
            options.manage === false ? ["read", "discover"] : ["read", "discover", "manage"],
            { kind: "tools", apps: permitted.map((app) => ({ app, tools: { kind: "all" } })) },
          )
        : options.manage === false
          ? authorization.selectedAuthority(["read", "discover"], { kind: "all" })
          : authorization.fullAuthority;
      const executor = {
        apps: {
          list: ({ owner: requestedOwner, ids }: { owner: string; ids?: readonly AppId[] }) =>
            Effect.gen(function* () {
              if (requestedOwner !== owner) return [];
              yield* read("apps");
              return [app, ...listed].filter(
                (candidate) => ids === undefined || ids.includes(candidate.id),
              );
            }),
        },
      } as unknown as Executor;
      const registrations = options.native
        ? (yield* poolAccountAcquisition(
            Option.some(Redacted.make("ab".repeat(32))),
            "https://pool.example",
          ).pipe(Effect.provideService(Crypto.Crypto, crypto))).registrations
        : ["codex", "apiKey"].map((method) => ({
            provider: accounts.openai!.provider,
            method,
            current: true,
            fetch: globalThis.fetch,
            capabilities: ["inference"],
            capabilityLabels: { inference: "Model inference" },
            driver: {
              id: method,
              revision: "1",
              importCredentials: () => Effect.void,
              cancel: () => Effect.void,
              remove: () => Effect.void,
              start: () => Effect.die("unused"),
              status: () => Effect.die("unused"),
            },
          }));
      const catalog = {
        list: Effect.gen(function* () {
          yield* read("catalog");
          if (catalogState === "failed") return yield* new sdk.StorageError();
          return catalogState === "empty" ? [] : entries;
        }),
      } as unknown as typeof HostedCatalog.Service;
      const reset = () => Object.assign(reads, emptyReads());
      reset();
      const operation = run({
        app,
        listed,
        reads,
        reset,
        sql,
        setCatalog: (state) => {
          catalogState = state;
        },
      }).pipe(
        Effect.provideService(GroupDatabase, Effect.succeed(sql)),
        Effect.provideService(CurrentOrganization, { organization, owner, role: "member" }),
        Effect.provideService(CurrentUserId, "person"),
        Effect.provideService(CurrentAuthorization, policy),
        Effect.provideService(HostedExecutor, Effect.succeed(executor)),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(sdk.AccountAcquisitionConfiguration, { registrations }),
      );
      return yield* options.catalog === false
        ? operation
        : operation.pipe(Effect.provideService(HostedCatalog, catalog));
    }),
  ).pipe(Effect.provide(pgliteLayer()));
