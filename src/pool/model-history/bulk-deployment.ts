import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Option } from "effect";
import { Api } from "../../../.upstream/apps/hosted/cloud/src/infrastructure/api-worker.ts";
import { poolDatabaseInfrastructure } from "../database.ts";
import { poolWorkerDatabase } from "../worker-database.ts";

/** Reuse the serving pool's existing connection and owner-admission service. */
export const bulkImportEnvironment = Effect.gen(function* () {
  const database = yield* poolDatabaseInfrastructure;
  const previous = yield* Config.option(Config.Redacted("POOL_APP_SIGNING_KEY_PREVIOUS"));
  return {
    POOL_AUTH_DATABASE: yield* poolWorkerDatabase(database.workerOrigin),
    POOL_APP_SIGNING_KEY: yield* Config.Redacted("POOL_APP_SIGNING_KEY"),
    TOOLS_SERVICE: yield* Api,
    ...(Option.isSome(previous) ? { POOL_APP_SIGNING_KEY_PREVIOUS: previous.value } : {}),
  };
});
