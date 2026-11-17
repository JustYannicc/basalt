import type { BarrierReceipt, VersionProvider } from "./barrier.ts";
import { BarrierRefusal, type FrozenWorker } from "./manifest.ts";
import { uploadFailure } from "./upload-failure.ts";

/** Two matching votes decide the median-of-three gate without spending an unnecessary third upload. */
export async function admitWorkerStartup(
  worker: FrozenWorker,
  receipt: Pick<BarrierReceipt, "pendingUpload" | "startupMeasurements">,
  options: {
    ceilingMs: number;
    upload: VersionProvider["upload"];
    unchanged(): void;
    record(): Promise<void>;
  },
) {
  const passing: { worker: string; versionId: string; startupTimeMs: number }[] = [];
  let exceeded = 0;
  for (let sample = 0; sample < 3; sample++) {
    options.unchanged();
    receipt.pendingUpload = { worker: worker.id };
    await options.record();
    let uploaded;
    try {
      uploaded = await options.upload(worker);
    } catch (error) {
      throw uploadFailure(error, worker.id);
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
    const measurement = {
      worker: worker.id,
      versionId: uploaded.versionId,
      startupTimeMs: startup,
    };
    (receipt.startupMeasurements ??= []).push(measurement);
    await options.record();
    if (startup <= options.ceilingMs) passing.push(measurement);
    else exceeded++;
    if (passing.length === 2)
      return passing.sort((left, right) => right.startupTimeMs - left.startupTimeMs)[0]!;
    if (exceeded === 2) throw new BarrierRefusal("startup-headroom", worker.id);
  }
  throw new BarrierRefusal("missing-or-invalid-startup-evidence", worker.id);
}
