import { productionOpsRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Command from "alchemy/Command";
import { Config, Effect, Option, Redacted } from "effect";
import { fileURLToPath } from "node:url";
import { verifyRuntimeDatabaseBudget } from "./database-budget.ts";
import { poolDatabaseInfrastructure } from "./database.ts";
import { poolWorkerDatabase } from "./worker-database.ts";
import { telemetryBindings, workerObservability } from "../telemetry/deployment.ts";
import { validSentryDsn } from "../telemetry/sentry-target.ts";
import { inventoryCron } from "./inventory.ts";
import { availabilityCron, validProbeTarget } from "./availability-config.ts";
import { ArtifactsCredentials } from "../../.upstream/apps/hosted/cloud/src/infrastructure/artifacts-credentials-worker.ts";
import { Api } from "../../.upstream/apps/hosted/cloud/src/infrastructure/api-worker.ts";

// Alchemy beta.80 forwards these Cloudflare API fields but omits them from its type.
// https://developers.cloudflare.com/containers/concepts/placement/
const euPlacement: Cloudflare.ContainerApplication.Constraints & {
  jurisdiction: "eu";
  regions: ("EEUR" | "WEUR")[];
} = { jurisdiction: "eu", regions: ["EEUR", "WEUR"] };

export const poolWorker = Effect.gen(function* () {
  const probeTarget = yield* Config.String("POOL_AVAILABILITY_TARGET").pipe(Config.withDefault(""));
  if (probeTarget && !validProbeTarget(probeTarget))
    return yield* Effect.die(new Error("Invalid pool availability target"));
  const recoveryTarget = yield* Config.String("POOL_AUTOMATIC_RECOVERY_TARGET").pipe(
    Config.withDefault(""),
  );
  if (recoveryTarget && (!validProbeTarget(recoveryTarget) || recoveryTarget !== probeTarget))
    return yield* Effect.die(
      new Error("Automatic recovery requires the same monitored pool target"),
    );
  if (probeTarget && !validSentryDsn(Redacted.value(yield* Config.Redacted("SENTRY_DSN"))))
    return yield* Effect.die(
      new Error("Pool availability monitoring requires a valid Sentry destination"),
    );
  const database = yield* poolDatabaseInfrastructure;
  const workerDatabase = yield* poolWorkerDatabase(database.workerOrigin);
  const image = Cloudflare.Container("PoolContainer", {
    context: fileURLToPath(new URL("../../containers/pool/", import.meta.url)),
    className: "PoolContainer",
    // The snapshot policy rejects placement constraints. EU enforcement takes priority.
    schedulingPolicy: "default",
    instanceType: "basic",
    maxInstances: 1,
    constraints: euPlacement,
    observability: { logs: { enabled: true } },
  });
  const application = yield* image.Application;
  // Set only while rotating: the Worker still accepts pool tokens signed with it.
  const previousSigningKey = yield* Config.option(Config.Redacted("POOL_APP_SIGNING_KEY_PREVIOUS"));
  const worker = yield* Cloudflare.Worker("PoolWorker", {
    main: fileURLToPath(new URL("./worker.ts", import.meta.url)),
    workersDev: false,
    compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
    crons: ["*/5 * * * *", inventoryCron, ...(probeTarget ? [availabilityCron] : [])],
    observability: workerObservability,
    env: {
      PoolContainer: image,
      BulkUsageImport: Cloudflare.DurableObject("ArtifactsTokenCoordinator", {
        className: "ArtifactsTokenCoordinator",
        scriptName: (yield* ArtifactsCredentials).workerName,
      }),
      POOL_DATABASE_URL: database.runtimeUrl,
      POOL_AUTH_DATABASE: workerDatabase,
      POOL_DEPLOYMENT_KEY: yield* Config.Redacted("POOL_DEPLOYMENT_KEY"),
      POOL_MANAGEMENT_KEY: yield* Config.Redacted("POOL_MANAGEMENT_KEY"),
      TOOLS_SERVICE: yield* Api,
      POOL_APP_SIGNING_KEY: yield* Config.Redacted("POOL_APP_SIGNING_KEY"),
      POOL_CLAUDE_QUOTA_DIAGNOSTIC: String(
        yield* Config.Boolean("POOL_CLAUDE_QUOTA_DIAGNOSTIC").pipe(Config.withDefault(false)),
      ),
      POOL_MODEL_HISTORY_ENABLED: String(
        yield* Config.Boolean("POOL_MODEL_HISTORY_ENABLED").pipe(Config.withDefault(false)),
      ),
      ...(yield* telemetryBindings),
      ...(Option.isSome(previousSigningKey)
        ? { POOL_APP_SIGNING_KEY_PREVIOUS: previousSigningKey.value }
        : {}),
      POOL_IMAGE_HASH: application.hash.pipe(
        Output.map((hash) => {
          if (!hash?.image) throw new Error("The pool image has no build revision");
          return hash.image;
        }),
      ),
      ...(probeTarget ? { POOL_AVAILABILITY_TARGET: probeTarget } : {}),
      ...(recoveryTarget ? { POOL_AUTOMATIC_RECOVERY_TARGET: recoveryTarget } : {}),
    },
  });
  yield* verifyRuntimeDatabaseBudget("PoolBackendBudget", {
    adminUrl: database.adminUrl,
    runtimeLogin: database.runtimeRole,
    databases: ["basalt_pool"],
    deployment: worker.hash,
    candidate: productionOpsRelease,
    readiness: {
      worker: worker.workerName,
      accountId: application.accountId,
      key: yield* Config.Redacted("POOL_DEPLOYMENT_KEY"),
      workerInput: poolWorkerRevision,
      imageHash: application.hash.pipe(Output.map((hash) => hash?.image ?? "")),
    },
  });
  const receiptPath = yield* Config.String("BASALT_POOL_IMAGE_RECEIPT").pipe(
    Config.withDefault(""),
  );
  if (receiptPath) {
    yield* Command.Exec("PoolImagePublicationReceipt", {
      command: "node capture-pool-image.ts",
      cwd: fileURLToPath(new URL("../../scripts/deploy-safety/", import.meta.url)),
      env: {
        BASALT_POOL_IMAGE_RECEIPT: receiptPath,
        GITHUB_SHA: yield* Config.NonEmptyString("GITHUB_SHA"),
        CLOUDFLARE_ACCOUNT_ID: application.accountId,
        CLOUDFLARE_API_TOKEN: yield* Config.Redacted("CLOUDFLARE_API_TOKEN"),
        POOL_APPLICATION_ID: application.applicationId,
        POOL_IMAGE_INPUT_HASH: application.hash.pipe(Output.map((hash) => hash?.image ?? "")),
        POOL_IMAGE_DIGEST: application.hash.pipe(Output.map((hash) => hash?.digest ?? "")),
        POOL_IMAGE_REF: application.configuration.pipe(
          Output.map((configuration) => configuration.image),
        ),
        POOL_WORKER_READY: worker.workerName,
      },
      memo: false,
      timeout: "1 minute",
    });
  }
  return worker;
});
