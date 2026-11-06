import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BarrierReceipt } from "./barrier.ts";
import {
  BarrierRefusal,
  describeWorker,
  manifestDigest,
  type ReleaseManifest,
} from "./manifest.ts";

const write = async (directory: string, name: string, value: unknown) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = resolve(directory, name);
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
};

/** Exact requests contain binding values and must stay outside the public receipt artifact. */
export function releaseEvidence(directory: string, candidate: string) {
  let fingerprint: string | undefined;
  let latest: BarrierReceipt | undefined;
  return {
    async manifest(manifest: ReleaseManifest) {
      await write(resolve(directory, "../release-barrier-private"), "frozen.json", {
        schemaVersion: 1,
        ...manifest,
        workers: manifest.workers.map((worker) => ({
          ...worker,
          files: worker.files.map((file) => ({
            name: file.name,
            type: file.type,
            base64: Buffer.from(file.bytes).toString("base64"),
          })),
        })),
      });
      fingerprint = manifestDigest(manifest);
      await write(directory, "manifest.json", {
        candidate: manifest.candidate,
        stack: manifest.stack,
        stage: manifest.stage,
        workers: manifest.workers.map(describeWorker),
      });
    },
    async record(receipt: BarrierReceipt) {
      await write(directory, "receipt.json", receipt);
      latest = structuredClone(receipt);
    },
    async recovery(value: unknown) {
      await write(directory, "recovery.json", value);
    },
    async failure(error: unknown) {
      const failure = {
        schemaVersion: 1,
        candidate,
        phase: latest?.phase === "complete" ? "finalize" : (latest?.phase ?? "preparation"),
        ceilingMs: 750,
        manifest: fingerprint ?? null,
        activated: latest?.activated ?? [],
        ...(latest?.pending ? { pending: latest.pending } : {}),
        ...(latest?.pendingUpload ? { pendingUpload: latest.pendingUpload } : {}),
        reason: error instanceof BarrierRefusal ? error.reason : "preparation-or-provider-failed",
        ...(error instanceof BarrierRefusal && error.worker ? { worker: error.worker } : {}),
      };
      await write(directory, "failure.json", failure);
      return failure;
    },
  };
}
