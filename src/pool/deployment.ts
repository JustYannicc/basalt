import { poolWorkerCompatibility } from "./worker-compatibility.ts";
import { productionOpsRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import { Config, Effect, Option, Redacted } from "effect";
import { fileURLToPath } from "node:url";
import { poolWorkerAcceptance } from "./database-budget.ts";
import { poolDatabaseInfrastructure } from "./database.ts";
import { fleetBindings, fleetClasses, fleetInfrastructure } from "./fleet-deployment.ts";
import { readinessImageInput } from "./image-release-plan.ts";
import { bindPoolObservation } from "./fleet-observation.ts";
import { rootContainer } from "./root-image-pin.ts";
import { poolWorkerDatabase } from "./worker-database.ts";
import { telemetryBindings, workerObservability } from "../telemetry/deployment.ts";
import { validSentryDsn } from "../telemetry/sentry-target.ts";
import { inventoryCron } from "./inventory.ts";
import { availabilityCron, validProbeTarget } from "./availability-config.ts";
import { ArtifactsCredentials } from "../../.upstream/apps/hosted/cloud/src/infrastructure/artifacts-credentials-worker.ts";
import { Api } from "../../.upstream/apps/hosted/cloud/src/infrastructure/api-worker.ts";

/**
 * Killing the elected Home master can lose a provider token rotation, which logs an account out.
 * Only a disposable stage, which holds test accounts, may do it. Every other stage, production
 * included, carries no binding, and the controller then refuses.
 */
export const masterCrashBinding = Effect.gen(function* () {
  // Annotated so the absent case stays an absent key, which is what a Worker binding map accepts.
  const binding: { POOL_ALLOW_MASTER_CRASH?: string } = (yield* Stage).startsWith("test-")
    ? { POOL_ALLOW_MASTER_CRASH: "true" }
    : {};
  return binding;
});

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
  const { image, application, imageHash, imageInput, pinnedInput } = yield* rootContainer;
  const fleet = yield* fleetInfrastructure;
  // Set only while rotating: the Worker still accepts pool tokens signed with it.
  const previousSigningKey = yield* Config.option(Config.Redacted("POOL_APP_SIGNING_KEY_PREVIOUS"));
  const worker = yield* Cloudflare.Worker("PoolWorker", {
    main: fileURLToPath(new URL("./worker.ts", import.meta.url)),
    workersDev: false,
    compatibility: {
      date: poolWorkerCompatibility.date,
      flags: [...poolWorkerCompatibility.flags],
    },
    crons: ["*/5 * * * *", inventoryCron, ...(probeTarget ? [availabilityCron] : [])],
    observability: workerObservability,
    env: {
      PoolContainer: image,
      ...fleetBindings(fleet, yield* fleetClasses),
      POOL_CONTAINER_APPLICATION_ID: application.applicationId,
      ...(yield* masterCrashBinding),
      // No release in this layer names a candidate image, so a pinned root expects the pin.
      POOL_DESIRED_IMAGE_INPUT: yield* readinessImageInput(pinnedInput, false).pipe(Effect.orDie),
      BulkUsageImport: Cloudflare.DurableObject("ArtifactsTokenCoordinator", {
        className: "ArtifactsTokenCoordinator",
        scriptName: (yield* ArtifactsCredentials).workerName,
      }),
      POOL_DATABASE_URL: database.runtimeUrl,
      POOL_DATABASE_READY: database.runtimeReady,
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
      POOL_IMAGE_HASH: imageHash,
      ...(probeTarget ? { POOL_AVAILABILITY_TARGET: probeTarget } : {}),
      ...(recoveryTarget ? { POOL_AUTOMATIC_RECOVERY_TARGET: recoveryTarget } : {}),
    },
  });
  yield* bindPoolObservation(worker, Boolean(fleet));
  yield* poolWorkerAcceptance(worker, {
    adminUrl: database.adminUrl,
    runtimeLogin: database.runtimeRole,
    candidate: productionOpsRelease,
    accountId: application.accountId,
    key: yield* Config.Redacted("POOL_DEPLOYMENT_KEY"),
    workerInput: poolWorkerRevision,
    imageHash: imageInput,
  });
  return worker;
});
