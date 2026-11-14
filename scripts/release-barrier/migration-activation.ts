import { BarrierRefusal, canonical } from "./manifest.ts";
import {
  checkpointReaderContract,
  migrationActivationTargets,
  type MigrationActivationIntent,
  type MigrationActivationPorts,
  type MigrationActivationSnapshot,
} from "./migration-activation-contract.ts";
import {
  ReleaseOperationError,
  releaseOperationFingerprint,
  runPlannedReleaseOperation,
} from "./release-operation.ts";

const sha = /^[a-f0-9]{64}$/u;
const roles = ["Api", "AppPages", "PoolWorker"] as const;

export function migrationActivationIntent(
  candidate: string,
  before: MigrationActivationSnapshot,
  allowActive = false,
): MigrationActivationIntent {
  if (before.candidate !== candidate || before.readers.release.candidate !== candidate)
    throw new BarrierRefusal("migration-activation-candidate-mismatch", "release.candidate");
  if (
    !sha.test(before.sourceFingerprint) ||
    !sha.test(before.readers.release.receiptDigest) ||
    !Number.isSafeInteger(before.readers.release.deploymentId) ||
    before.readers.release.deploymentId <= 0
  )
    throw new BarrierRefusal("migration-activation-release-evidence-invalid", "release");
  const workers = before.readers.workers;
  if (
    workers.length !== roles.length ||
    roles.some((role) => workers.filter((worker) => worker.role === role).length !== 1)
  )
    throw new BarrierRefusal("migration-activation-reader-coverage", "Api,AppPages,PoolWorker");
  for (const worker of workers) {
    if (
      !sha.test(worker.target) ||
      !worker.versionId ||
      worker.versionId !== worker.acceptedVersionId ||
      worker.percentage !== 100
    )
      throw new BarrierRefusal("migration-activation-readers-not-retired", worker.role, {
        fqn: worker.role,
        type: "Cloudflare.Worker",
        changed: [
          {
            path: "deployment.versions",
            old: canonical({ versionId: worker.acceptedVersionId, percentage: 100 }),
            new: canonical({ versionId: worker.versionId, percentage: worker.percentage }),
          },
        ],
      });
  }
  const adoption = before.readers.poolAdoption;
  if (
    adoption.candidate !== candidate ||
    !sha.test(adoption.poolWorkerRevision) ||
    !sha.test(adoption.imageInput)
  )
    throw new BarrierRefusal("migration-activation-reader-adoption-missing", "PoolWorker");
  if (
    !Number.isSafeInteger(before.readers.apps.count) ||
    before.readers.apps.count < 0 ||
    !sha.test(before.readers.apps.fingerprint)
  )
    throw new BarrierRefusal("migration-activation-app-inventory-incomplete", "SQL.tools");
  if (!before.hosted.prepared || !before.pool.prepared)
    throw new BarrierRefusal(
      "migration-activation-not-prepared",
      [!before.hosted.prepared ? "hosted.21" : "", !before.pool.prepared ? "model-history.v9" : ""]
        .filter(Boolean)
        .join(","),
    );
  if (!allowActive && before.hosted.active && before.pool.active)
    throw new BarrierRefusal("migration-activation-already-active", "hosted.22,model-history.v10");
  if (
    !sha.test(before.hosted.fingerprint) ||
    !sha.test(before.pool.schemaHash) ||
    !sha.test(before.pool.catalogHash)
  )
    throw new BarrierRefusal("migration-activation-schema-evidence-invalid", "SQL.tools,SQL.pool");
  return { contract: checkpointReaderContract, targets: migrationActivationTargets, before };
}

/** Only a validated, freshly collected plan can produce the internal reader acknowledgement. */
export async function runMigrationActivation(options: {
  candidate: string;
  mode: string;
  ports: MigrationActivationPorts;
}) {
  const { ports, candidate, mode } = options;
  if (!/^[a-f0-9]{40}$/u.test(candidate))
    throw new BarrierRefusal("migration-activation-candidate-required", "candidate");
  if (mode !== "plan" && mode !== "inspect" && !/^[a-f0-9]{64}$/u.test(mode))
    throw new BarrierRefusal("migration-activation-mode-invalid", "migration_activation");
  const existing = await ports.load();
  // Sent receipts are inspected without replanning or replacing their durable intent.
  const intent =
    existing?.sent === true
      ? undefined
      : migrationActivationIntent(candidate, await ports.read(), mode === "inspect");
  if (intent && /^[a-f0-9]{64}$/u.test(mode)) {
    const fingerprint = releaseOperationFingerprint(candidate, intent);
    if (mode !== fingerprint)
      throw new BarrierRefusal("migration-activation-plan-stale", "plan", {
        fqn: "plan",
        type: "MigrationActivation",
        changed: [{ path: "fingerprint", old: mode, new: fingerprint }],
      });
  }
  try {
    return await runPlannedReleaseOperation({
      candidate,
      mode,
      ...(existing ? { existing } : {}),
      plan: async () => {
        if (intent === undefined) throw new BarrierRefusal("migration-activation-plan-missing");
        return intent;
      },
      execute: async (approved) => {
        await ports.activate(approved);
        const observed = await ports.inspect(approved);
        if (observed.status !== "complete")
          throw new BarrierRefusal(
            "migration-activation-outcome-pending",
            "hosted.22,model-history.v10",
          );
        return observed.result;
      },
      inspect: ports.inspect,
      save: ports.save,
    });
  } catch (error) {
    if (error instanceof ReleaseOperationError)
      throw new BarrierRefusal(error.message, "migration_activation");
    throw error;
  }
}
