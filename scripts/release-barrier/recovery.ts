import type { ContainerHealth } from "./container-health.ts";
import { Schema } from "effect";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import {
  readRecoveryManifest,
  recoveryReceipt,
  type readRecoveryProgress,
  type RecoveryWorker,
  type RecoveryManifest,
  type RecoveryAdmission,
} from "./recovery-manifest.ts";
export { readRecoveryManifest, type RecoveryWorker } from "./recovery-manifest.ts";

export interface RecoveryReceipt {
  candidate: string;
  manifest: string;
  restored: string[];
  pending?: string;
  failure?: string;
  containers?: {
    container: string;
    version: number;
    rolloutId?: string;
    verified?: boolean;
    health?: ContainerHealth;
  }[];
  pendingContainer?: {
    container: string;
    phase: "rollout" | "verification";
    version?: number;
    rolloutId?: string;
  };
}
export interface RecoveryProvider {
  read(worker: RecoveryWorker): Promise<{ target: string; versions: RecoveryWorker["baseline"] }>;
  restore(worker: RecoveryWorker): Promise<void>;
}

/** Reconcile uncertain calls from live version IDs; never force a secret transition or repeat an unobserved write. */
export async function recoverWorkers(
  manifestValue: unknown,
  receiptValue: unknown,
  provider: RecoveryProvider,
  record: (receipt: RecoveryReceipt) => Promise<void>,
  beforeRestore?: (
    manifest: RecoveryManifest,
    admitted: RecoveryAdmission,
    progress: RecoveryReceipt,
    save: () => Promise<void>,
    deployments: ReadonlyMap<string, "baseline" | "candidate">,
  ) => Promise<void>,
  previous?: ReturnType<typeof readRecoveryProgress>,
) {
  const manifest = readRecoveryManifest(manifestValue);
  const admitted = Schema.decodeUnknownSync(recoveryReceipt)(receiptValue);
  const fingerprint = digest(canonical(manifest));
  if (
    fingerprint !== admitted.manifest ||
    manifest.candidate !== admitted.candidate ||
    !manifest.workers.length ||
    new Set(manifest.workers.map((item) => item.id)).size !== manifest.workers.length
  )
    throw new BarrierRefusal("recovery-receipt-mismatch");
  if ("containers" in manifest && (!beforeRestore || admitted.schemaVersion !== 2))
    throw new BarrierRefusal("container-recovery-required");
  if (previous && (previous.candidate !== manifest.candidate || previous.manifest !== fingerprint))
    throw new BarrierRefusal("recovery-progress-mismatch");
  const progress: RecoveryReceipt = {
    candidate: manifest.candidate,
    manifest: fingerprint,
    restored: [],
    ...(previous?.containers
      ? { containers: previous.containers.map((item) => ({ ...item })) }
      : {}),
    ...(previous?.pendingContainer ? { pendingContainer: { ...previous.pendingContainer } } : {}),
  };
  const save = () => record(structuredClone(progress));
  try {
    await save();
    const pending: RecoveryWorker[] = [];
    const deployments = new Map<string, "baseline" | "candidate">();
    for (const worker of manifest.workers) {
      if (
        !worker.baseline.length ||
        worker.baseline.some((version) => !version.versionId || version.percentage <= 0) ||
        worker.baseline.reduce((sum, version) => sum + version.percentage, 0) !== 100
      )
        throw new BarrierRefusal("invalid-recovery-baseline", worker.id);
      const current = await provider.read(worker);
      if (current.target !== worker.target)
        throw new BarrierRefusal("recovery-target-drift", worker.id);
      if (canonical(current.versions) === canonical(worker.baseline)) {
        deployments.set(worker.id, "baseline");
        continue;
      }
      const accepted = admitted.accepted.find((item) => item.worker === worker.id);
      if (
        !accepted ||
        canonical(current.versions) !==
          canonical([{ versionId: accepted.versionId, percentage: 100 }])
      )
        throw new BarrierRefusal("recovery-deployment-drift", worker.id);
      deployments.set(worker.id, "candidate");
      pending.push(worker);
    }
    await beforeRestore?.(manifest, admitted, progress, save, deployments);
    for (const worker of pending.reverse()) {
      progress.pending = worker.id;
      await save();
      await provider.restore(worker);
      const observed = await provider.read(worker);
      if (
        observed.target !== worker.target ||
        canonical(observed.versions) !== canonical(worker.baseline)
      )
        throw new BarrierRefusal("recovery-unconfirmed", worker.id);
      progress.restored.push(worker.id);
      delete progress.pending;
      await save();
    }
    return progress;
  } catch (error) {
    progress.failure = error instanceof BarrierRefusal ? error.reason : "recovery-unconfirmed";
    await save();
    throw error instanceof BarrierRefusal
      ? error
      : new BarrierRefusal(progress.failure, progress.pending);
  }
}
