import assert from "node:assert/strict";
import { test } from "node:test";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Command from "alchemy/Command";
import * as Planetscale from "alchemy/Planetscale";
import { Resource } from "alchemy/Resource";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { ConfigProvider, Context, Effect, Layer, Redacted } from "effect";
import { poolDatabaseInfrastructure } from "../../src/pool/database.ts";
import { runtimeReleaseDesired } from "./runtime-release-desired.ts";
import { withReleaseRuntime } from "./runtime.ts";

interface Worker extends Resource<"Fixture.RuntimeWorker", { env: Record<string, unknown> }, {}> {}
const Worker = Resource<Worker>("Fixture.RuntimeWorker");
const origin: Planetscale.PostgresOrigin = {
  scheme: "postgresql",
  host: "database.example",
  port: 6432,
  database: "postgres",
  user: "pool.branch",
  password: Redacted.make("fixture-password"),
};
const url =
  "postgresql://pool.branch:fixture-password@database.example:6432/basalt_pool?sslmode=verify-full";

function fixture(options: { seed?: boolean; replaceRole?: boolean; failReadiness?: boolean } = {}) {
  let seeded = false;
  let workerWrites = 0;
  let commandWrites = 0;
  const planetProviders = Layer.mergeAll(
    Provider.succeed(Planetscale.PostgresBranch, {
      reconcile: ({ news }) =>
        Effect.succeed({
          name: news.name!,
          organization: "fixture",
          database: "basalt-preview-pr-1",
          parentBranch: "main",
          production: false,
          createdAt: "",
          updatedAt: "",
          htmlUrl: "https://example.com",
          region: { slug: "fixture" },
          migrationsDir: undefined,
          migrationsTable: undefined,
          migrationsHashes: {},
          importHashes: {},
          desiredReplicas: undefined,
          hasReplicas: undefined,
          hasReadOnlyReplicas: undefined,
        }),
      delete: () => Effect.void,
    }),
    Provider.succeed(Planetscale.PostgresRole, {
      diff: () => Effect.succeed(seeded && options.replaceRole ? { action: "replace" } : undefined),
      reconcile: ({ id }) =>
        Effect.succeed({
          id,
          name: id,
          expiresAt: null,
          host: origin.host,
          username: origin.user,
          password: origin.password,
          database: "basalt-preview-pr-1",
          databaseName: "postgres",
          origin: { ...origin, port: 5432 },
          pooledOrigin: origin,
          privateHost: "",
          privateConnectionServiceName: "",
          connectionUrl: Redacted.make("fixture-direct"),
          connectionUrlPooled: Redacted.make(url),
          inheritedRoles: [],
          withReplication: false,
          successor: "postgres",
          organization: "fixture",
          branch: "test-pr-1-pool",
          ttl: null,
        }),
      delete: () => Effect.void,
    }),
  );
  const providers = Layer.mergeAll(
    Layer.effect(
      Planetscale.Providers,
      Provider.collection([Planetscale.PostgresBranch, Planetscale.PostgresRole]),
    ).pipe(Layer.provideMerge(planetProviders)),
    Provider.succeed(Command.Exec, {
      diff: () => Effect.succeed({ action: "update" }),
      reconcile: () =>
        Effect.sync(() => {
          if (seeded) {
            commandWrites++;
            if (options.failReadiness) throw new Error("fixture-database-not-ready");
          }
          return { hash: { input: "fixture-command" } };
        }),
      delete: () => Effect.void,
    }),
    Provider.succeed(Worker, {
      reconcile: () =>
        Effect.sync(() => {
          if (seeded) workerWrites++;
          return {};
        }),
      delete: () => Effect.void,
    }),
  );
  const stack = Stack(
    "fixture",
    { providers, state: Layer.effect(State, InMemoryService().pipe(Effect.map(Effect.succeed))) },
    Effect.gen(function* () {
      const database = yield* poolDatabaseInfrastructure;
      yield* Worker("PoolWorker", {
        env: {
          POOL_DATABASE_URL: database.runtimeUrl,
          POOL_DATABASE_READY: database.runtimeReady,
          POOL_MANAGEMENT_KEY: Redacted.make("candidate-management"),
          POOL_APP_SIGNING_KEY: Redacted.make("candidate-signing"),
        },
      });
    }),
  );
  return {
    run: () =>
      Effect.runPromise(
        evalStack(
          stack,
          (compiled) =>
            Effect.gen(function* () {
              if (options.seed !== false) yield* Apply.apply(yield* Plan.make(compiled));
              seeded = true;
              const desired = yield* runtimeReleaseDesired(compiled);
              assert.equal(commandWrites, 0);
              assert.equal(workerWrites, 0);
              if (options.failReadiness) yield* Apply.apply(yield* Plan.make(compiled));
              return desired;
            }).pipe(
              Effect.provideContext(compiled.services),
              Effect.provideService(State, Context.get(compiled.services, State)),
            ),
          { stage: "test-pr-1" },
        ).pipe(
          withReleaseRuntime,
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  TEST_STAGE_DATABASE: "basalt-preview-pr-1",
                },
              }),
            ),
          ),
        ),
      ),
    writes: () => ({ workerWrites, commandWrites }),
  };
}

test("desired runtime reads an existing database URL while readiness commands need another apply", async () => {
  const result = await fixture().run();
  assert.equal(result.configuration.databaseUrl, url);
  assert.equal(result.configuration.managementKey, "candidate-management");
  assert.equal(result.configuration.signingKey, "candidate-signing");
  assert.match(result.imageInput, /^[a-f0-9]{16}$/);
});

for (const options of [{ seed: false }, { replaceRole: true }])
  test(`desired runtime refuses an unavailable database role (${JSON.stringify(options)})`, async () => {
    await assert.rejects(fixture(options).run(), /runtime-release-desired-setting-unavailable/);
  });

test("database readiness failure still blocks Worker apply after desired settings are read", async () => {
  const f = fixture({ failReadiness: true });
  await assert.rejects(f.run(), /fixture-database-not-ready/);
  assert.equal(f.writes().workerWrites, 0);
  assert.ok(f.writes().commandWrites > 0);
});
