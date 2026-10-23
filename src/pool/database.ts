import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Planetscale from "alchemy/Planetscale";
import { Effect, Redacted } from "effect";
import { fileURLToPath } from "node:url";
import { poolDatabaseUrl } from "./database-settings.ts";

/** A logical database inside the tools service's existing PlanetScale cluster. */
export const poolDatabaseInfrastructure = Effect.gen(function* () {
  const cluster = yield* Planetscale.PostgresDatabase.ref("Database");
  const admin = yield* Planetscale.PostgresRole.ref("MigrationRole");
  const runtime = yield* Planetscale.PostgresRole("PoolDatabaseRole", {
    database: cluster,
    inheritedRoles: [],
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
