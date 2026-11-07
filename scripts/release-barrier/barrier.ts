import {
  BarrierRefusal,
  canonical,
  manifestDigest,
  snapshotManifest,
  type FrozenWorker,
  type ReleaseManifest,
} from "./manifest.ts";

export interface VersionProvider {
  upload(
    worker: FrozenWorker,
  ): Promise<{ versionId?: string | null; startupTimeMs?: number | null }>;
  baseline(worker: FrozenWorker): Promise<FrozenWorker["baseline"]>;
  activate(worker: FrozenWorker, versionId: string): Promise<void>;
}

export interface BarrierReceipt {
  schemaVersion: 1;
  candidate: string;
  manifest: string;
  ceilingMs: number;
  phase: "upload" | "admitted" | "baseline" | "activation" | "complete";
  accepted: { worker: string; versionId: string; startupTimeMs: number }[];
  activated: { worker: string; versionId: string }[];
  pending?: { worker: string; versionId: string };
  pendingUpload?: { worker: string; versionId?: string; startupTimeMs?: number };
  failure?: { reason: string; worker?: string };
}

export interface BarrierOptions {
  provider: VersionProvider;
  record(receipt: BarrierReceipt): Promise<void>;
  beforeActivate?(): Promise<void>;
  ceilingMs?: number;
}

/** Admission is complete before any caller can activate a version. */
export async function releaseWorkers(
  input: ReleaseManifest,
  options: BarrierOptions,
): Promise<BarrierReceipt> {
  const manifest = snapshotManifest(input);
  const ceilingMs = options.ceilingMs ?? 750;
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0 || ceilingMs > 750)
    throw new BarrierRefusal("invalid-ceiling");
  const fingerprint = manifestDigest(manifest);
  const receipt: BarrierReceipt = {
    schemaVersion: 1,
    candidate: manifest.candidate,
    manifest: fingerprint,
    ceilingMs,
    phase: "upload",
    accepted: [],
    activated: [],
  };
  const record = () => options.record(structuredClone(receipt));
  const unchanged = () => {
    if (manifestDigest(manifest) !== fingerprint || manifestDigest(input) !== fingerprint)
      throw new BarrierRefusal("manifest-drift");
  };
  try {
    await record();
    for (const worker of manifest.workers) {
      unchanged();
      receipt.pendingUpload = { worker: worker.id };
      await record();
      let uploaded;
      try {
        uploaded = await options.provider.upload(worker);
      } catch {
        throw new BarrierRefusal("upload-rejected-or-unconfirmed", worker.id);
      }
      receipt.pendingUpload = {
        worker: worker.id,
        ...(uploaded.versionId ? { versionId: uploaded.versionId } : {}),
        ...(typeof uploaded.startupTimeMs === "number" && Number.isFinite(uploaded.startupTimeMs)
          ? { startupTimeMs: uploaded.startupTimeMs }
          : {}),
      };
      if (!uploaded.versionId?.trim()) throw new BarrierRefusal("missing-version-id", worker.id);
      const startup = uploaded.startupTimeMs;
      if (typeof startup !== "number" || !Number.isFinite(startup) || startup < 0)
        throw new BarrierRefusal("missing-or-invalid-startup-evidence", worker.id);
      if (startup > ceilingMs) throw new BarrierRefusal("startup-headroom", worker.id);
      receipt.accepted.push({
        worker: worker.id,
        versionId: uploaded.versionId,
        startupTimeMs: startup,
      });
      delete receipt.pendingUpload;
      await record();
    }
    unchanged();
    receipt.phase = "admitted";
    await record();
    // The database phase can run only after every Worker has provider acceptance.
    await options.beforeActivate?.();
    unchanged();
    receipt.phase = "baseline";
    await record();
    for (const worker of manifest.workers) {
      const current = await options.provider.baseline(worker);
      if (canonical(current) !== canonical(worker.baseline))
        throw new BarrierRefusal("deployment-drift", worker.id);
    }
    receipt.phase = "activation";
    for (const accepted of receipt.accepted) {
      unchanged();
      const worker = manifest.workers.find((item) => item.id === accepted.worker)!;
      // Persist intent first. A lost response must remain an uncertain activation, never a blind retry.
      receipt.pending = { worker: worker.id, versionId: accepted.versionId };
      await record();
      await options.provider.activate(worker, accepted.versionId);
      receipt.activated.push(receipt.pending);
      delete receipt.pending;
      await record();
    }
    receipt.phase = "complete";
    await record();
    return receipt;
  } catch (error) {
    receipt.failure =
      error instanceof BarrierRefusal
        ? { reason: error.reason, ...(error.worker ? { worker: error.worker } : {}) }
        : {
            reason:
              receipt.phase === "activation"
                ? "activation-unconfirmed"
                : "barrier-operation-failed",
          };
    await record();
    throw error instanceof BarrierRefusal
      ? error
      : new BarrierRefusal(receipt.failure.reason, receipt.pending?.worker);
  }
}
