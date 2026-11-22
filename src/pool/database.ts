import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Planetscale from "alchemy/Planetscale";
import { adopt } from "alchemy/AdoptPolicy";
import type { Input } from "alchemy/Input";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Option, Redacted } from "effect";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { poolDatabase, poolDatabaseUrl, previewPoolDatabaseBranch } from "./database-settings.ts";
import { poolDatabaseInputs } from "./model-history/sources.ts";
import { databasePoolBudget } from "../../.upstream/apps/hosted/cloud/src/infrastructure/database-pool-budget.ts";
import { postgresUrl } from "../../.upstream/apps/hosted/cloud/src/infrastructure/preview-database.ts";

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
        if (globalThis.__ALCHEMY_RUNTIME__) {
          return {
            admin: yield* Planetscale.PostgresRole.ref("MigrationRole"),
            runtime: yield* Planetscale.PostgresRole.ref("PoolDatabaseRole"),
          };
        }
        // `.ref` reads deployed state, which a first deploy does not have yet. Registering the tools
        // service's cluster and schema-owner role again with its exact props and policies returns the
        // instances its cloud deployment registered, in either order.
        const settings = yield* Config.all({
          name: Config.String("PLANETSCALE_DATABASE_NAME"),
          clusterSize: Config.String("PLANETSCALE_CLUSTER_SIZE"),
          region: Config.String("PLANETSCALE_REGION"),
          adopt: Config.Boolean("PLANETSCALE_ADOPT_DATABASE").pipe(Config.withDefault(false)),
        });
        const cluster = yield* Planetscale.PostgresDatabase("Database", {
          name: settings.name,
          clusterSize: settings.clusterSize,
          region: { slug: settings.region },
        }).pipe(adopt(settings.adopt), retain());
        return {
          admin: yield* Planetscale.PostgresRole("MigrationRole", {
            database: cluster,
            inheritedRoles: ["postgres"],
          }).pipe(retain()),
          runtime: yield* Planetscale.PostgresRole("PoolDatabaseRole", {
            database: cluster,
            inheritedRoles: [],
          }),
        };
      });
  const budget = globalThis.__ALCHEMY_RUNTIME__
    ? undefined
    : yield* databasePoolBudget(
        isPreview ? "PoolDatabaseBudget" : "RuntimeDatabaseBudget",
        yield* Config.NonEmptyString(
          isPreview ? "TEST_STAGE_DATABASE" : "PLANETSCALE_DATABASE_NAME",
        ),
        isPreview ? previewPoolDatabaseBranch(stageName!) : "main",
      );
  const readyHash = yield* poolDatabaseReadiness({
    adminUrl: admin.connectionUrl,
    // `name` is PlanetScale's display name; the Postgres role that logs in is `username`.
    runtimeRole: runtime.username,
    budget,
  });
  return {
    adminUrl: admin.connectionUrl,
    runtimeRole: runtime.username,
    // Desired settings are read before apply; readiness is a separate Worker dependency.
    runtimeReady: readyHash,
    runtimeUrl: runtime.pooledOrigin.pipe(
      Output.map((origin) => Redacted.make(poolDatabaseUrl(Redacted.value(postgresUrl(origin))))),
    ),
    // Fresh previews need initialization; production admission runs it before activation.
    workerOrigin: (isPreview
      ? Output.all(runtime.pooledOrigin, readyHash).pipe(Output.map(([origin]) => origin))
      : runtime.pooledOrigin
    ).pipe(Output.map((origin) => ({ ...origin, database: poolDatabase.name }))),
  };
});

/**
 * The pool database command, and the readiness value the pool Worker and, on test stages, its
 * database connection read from it. It waits on the pool size command, which sets the connection
 * budget it provisions within, and on nothing else that runs at deploy time: the tools migration
 * re-runs whenever a hosted source changes, and waiting on it would leave this command's outcome,
 * and so the pool Worker, unknown at plan time on nearly every release. The command writes only the
 * cluster's role and database catalogs and the pool's own database, never the tools schema, under
 * an advisory lock the migration never takes; the pool Worker reaches tools data only through the
 * tools Worker, which waits on that migration itself.
 */
export const poolDatabaseReadiness = (inputs: {
  adminUrl: Input<Redacted.Redacted<string>>;
  runtimeRole: Input<string>;
  budget: { readonly hash: Output.Output<unknown, never> } | undefined;
}) =>
  Effect.gen(function* () {
    const { budget } = inputs;
    const script = fileURLToPath(new URL("../../scripts/ensure-pool-database.ts", import.meta.url));
    const ready = yield* Command.Exec("PoolDatabase", {
      // Alchemy splits the command on whitespace without a shell, so quotes would reach node literally.
      command: `node ${basename(script)}`,
      cwd: dirname(script),
      env: {
        ...(budget
          ? { DATABASE_POOL_BUDGET_READY: budget.hash.pipe(Output.map(() => "ready")) }
          : {}),
        POOL_DATABASE_ADMIN_URL: inputs.adminUrl,
        POOL_DATABASE_RUNTIME_ROLE: inputs.runtimeRole,
      },
      // The pool Worker and, on test stages, its database connection read this command's outcome.
      // A plan cannot know the outcome of a command that runs on every plan, so they would plan as
      // updates forever. Keyed on what the command reads, it runs when that changes, on every stage.
      memo: poolDatabaseInputs,
      // The script bounds itself at 132s (worstCaseMs in scripts/pool-database-provisioning.ts) and
      // exits with the step it failed at. This outer limit only catches a script that cannot exit.
      timeout: "3 minutes",
    });
    return Output.all(ready.hash, budget?.hash ?? ready.hash).pipe(Output.map(() => "ready"));
  });
