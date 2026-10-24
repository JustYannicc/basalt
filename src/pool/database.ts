import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Planetscale from "alchemy/Planetscale";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Option, Redacted } from "effect";
import { fileURLToPath } from "node:url";
import { poolDatabaseUrl, previewPoolDatabaseBranch } from "./database-settings.ts";

/** A logical database inside the tools service's existing PlanetScale cluster. */
export const poolDatabaseInfrastructure = Effect.gen(function* () {
  const stackStage = yield* Effect.serviceOption(Stage);
  const configuredStage = yield* Config.String("ALCHEMY_STAGE").pipe(Config.option);
  const stageName = Option.getOrUndefined(stackStage) ?? Option.getOrUndefined(configuredStage);
  const isPreview = stageName !== undefined && /^test-pr-[1-9][0-9]*$/.test(stageName);
  if (stageName?.startsWith("test-") && !isPreview)
    return yield* Effect.die(new Error("Pool database is restricted to PR preview stages."));
  const { admin, runtime } = isPreview
    ? yield* Effect.gen(function* () {
        const database = yield* Config.NonEmptyString("TEST_STAGE_DATABASE");
        const expectedDatabase = `basalt-preview-pr-${stageName!.slice("test-pr-".length)}`;
        if (database !== expectedDatabase)
          return yield* Effect.die(new Error("Pool database parent does not match the PR stage."));
        if (globalThis.__ALCHEMY_RUNTIME__) {
          return {
            admin: yield* Planetscale.PostgresRole.ref("PoolDatabaseMigrationRole"),
            runtime: yield* Planetscale.PostgresRole.ref("PoolDatabaseRole"),
          };
        }
        const branch = yield* Planetscale.PostgresBranch("PoolDatabaseBranch", {
          database,
          name: previewPoolDatabaseBranch(stageName!),
          parentBranch: "main",
        });
        return {
          admin: yield* Planetscale.PostgresRole("PoolDatabaseMigrationRole", {
            database,
            branch,
            inheritedRoles: ["postgres"],
          }),
          runtime: yield* Planetscale.PostgresRole("PoolDatabaseRole", {
            database,
            branch,
            inheritedRoles: [],
          }),
        };
      })
    : yield* Effect.gen(function* () {
        const cluster = yield* Planetscale.PostgresDatabase.ref("Database");
        return {
          admin: yield* Planetscale.PostgresRole.ref("MigrationRole"),
          runtime: yield* Planetscale.PostgresRole("PoolDatabaseRole", {
            database: cluster,
            inheritedRoles: [],
          }),
        };
      });
  const script = fileURLToPath(new URL("../../scripts/ensure-pool-database.ts", import.meta.url));
  const ready = yield* Command.Exec("PoolDatabase", {
    command: "node '" + script.replaceAll("'", "'\\''") + "'",
    env: {
      POOL_DATABASE_ADMIN_URL: admin.connectionUrl,
      POOL_DATABASE_RUNTIME_ROLE: runtime.name,
    },
    memo: false,
    timeout: "1 minute",
  });
  return Output.all(runtime.connectionUrl, ready.hash).pipe(
    Output.map(([url]) => Redacted.make(poolDatabaseUrl(Redacted.value(url)))),
  );
});
