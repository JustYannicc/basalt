import { Schema } from "effect";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";

const baseline = Schema.Array(
  Schema.Struct({ versionId: Schema.String, percentage: Schema.Number }),
);
const worker = Schema.Struct({
  id: Schema.String,
  target: Schema.String,
  metadata: Schema.String,
  sourceMetadata: Schema.optional(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      bytes: Schema.Number,
      sha256: Schema.String,
    }),
  ),
  baseline,
});
const description = Schema.Struct({
  candidate: Schema.String,
  stack: Schema.String,
  stage: Schema.String,
  workers: Schema.Array(worker),
});
const receipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: Schema.String,
  manifest: Schema.String,
  accepted: Schema.Array(
    Schema.Struct({
      worker: Schema.String,
      versionId: Schema.String,
      startupTimeMs: Schema.Number,
    }),
  ),
});
export const readRecoveryManifest = Schema.decodeUnknownSync(description);
export type RecoveryWorker = typeof worker.Type;
export interface RecoveryReceipt {
  candidate: string;
  manifest: string;
  restored: string[];
  pending?: string;
  failure?: string;
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
) {
  const manifest = readRecoveryManifest(manifestValue);
  const admitted = Schema.decodeUnknownSync(receipt)(receiptValue);
  const fingerprint = digest(canonical(manifest));
  if (
    fingerprint !== admitted.manifest ||
    manifest.candidate !== admitted.candidate ||
    !manifest.workers.length ||
    new Set(manifest.workers.map((item) => item.id)).size !== manifest.workers.length
  )
    throw new BarrierRefusal("recovery-receipt-mismatch");
  const progress: RecoveryReceipt = {
    candidate: manifest.candidate,
    manifest: fingerprint,
    restored: [],
  };
  const save = () => record(structuredClone(progress));
  try {
    await save();
    const pending: RecoveryWorker[] = [];
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
      if (canonical(current.versions) === canonical(worker.baseline)) continue;
      const accepted = admitted.accepted.find((item) => item.worker === worker.id);
      if (
        !accepted ||
        canonical(current.versions) !==
          canonical([{ versionId: accepted.versionId, percentage: 100 }])
      )
        throw new BarrierRefusal("recovery-deployment-drift", worker.id);
      pending.push(worker);
    }
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
