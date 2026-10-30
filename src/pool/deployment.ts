import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { Config, Effect, Option } from "effect";
import { fileURLToPath } from "node:url";
import { poolDatabaseInfrastructure } from "./database.ts";
import { poolWorkerDatabase } from "./worker-database.ts";
import { telemetryBindings, workerObservability } from "../telemetry/deployment.ts";
import { inventoryCron } from "./inventory.ts";

// Alchemy beta.80 forwards these Cloudflare API fields but omits them from its type.
// https://developers.cloudflare.com/containers/concepts/placement/
const euPlacement: Cloudflare.ContainerApplication.Constraints & {
  jurisdiction: "eu";
  regions: ("EEUR" | "WEUR")[];
} = { jurisdiction: "eu", regions: ["EEUR", "WEUR"] };

export const poolWorker = Effect.gen(function* () {
  const database = yield* poolDatabaseInfrastructure;
  const workerDatabase = yield* poolWorkerDatabase(database.workerOrigin);
  const image = Cloudflare.Container("PoolContainer", {
    context: fileURLToPath(new URL("../../containers/pool/", import.meta.url)),
    className: "PoolContainer",
    // The snapshot policy rejects placement constraints. EU enforcement takes priority.
    schedulingPolicy: "default",
    instanceType: "lite",
    maxInstances: 1,
    constraints: euPlacement,
    observability: { logs: { enabled: true } },
  });
  const application = yield* image.Application;
  // Set only while rotating: the Worker still accepts pool tokens signed with it.
  const previousSigningKey = yield* Config.option(Config.Redacted("POOL_APP_SIGNING_KEY_PREVIOUS"));
  return yield* Cloudflare.Worker("PoolWorker", {
    main: fileURLToPath(new URL("./worker.ts", import.meta.url)),
    workersDev: false,
    compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
    crons: ["*/5 * * * *", inventoryCron],
    observability: workerObservability,
    env: {
      PoolContainer: image,
      POOL_DATABASE_URL: database.directUrl,
      POOL_AUTH_DATABASE: workerDatabase,
      POOL_MANAGEMENT_KEY: yield* Config.Redacted("POOL_MANAGEMENT_KEY"),
      POOL_APP_SIGNING_KEY: yield* Config.Redacted("POOL_APP_SIGNING_KEY"),
      ...(yield* telemetryBindings),
      ...(Option.isSome(previousSigningKey) ? { POOL_APP_SIGNING_KEY_PREVIOUS: previousSigningKey.value } : {}),
      POOL_IMAGE_HASH: application.hash.pipe(Output.map((hash) => {
        if (!hash?.image) throw new Error("The pool image has no build revision");
        return hash.image;
      })),
    },
  });
});
