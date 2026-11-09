import { ServingFailure } from "./serving-failure.ts";
import { operationFailure, ReleaseOperationFailure } from "./operation-failure.ts";
import { appendFile, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BarrierReceipt } from "./barrier.ts";
import {
  BarrierRefusal,
  describeWorker,
  manifestDigest,
  type ReleaseManifest,
} from "./manifest.ts";
import {
  describeContainer,
  type BaselineNormalization,
  type FrozenContainer,
} from "./container.ts";
import { Schema } from "effect";
import type { ServingContainer } from "./container-serving.ts";
import type { VerificationAdmission } from "./plan-admission.ts";
import { sealRecovery } from "./recovery-envelope.ts";
import { declaredEvidence } from "./declared-evidence.ts";

const write = async (directory: string, name: string, value: unknown) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = resolve(directory, name);
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
};

/** Exact requests contain binding values and must stay outside the public receipt artifact. */
export function releaseEvidence(directory: string, candidate: string, encryptionKey?: string) {
  let fingerprint: string | undefined;
  let latest: BarrierReceipt | undefined;
  const declared = declaredEvidence(
    (name, value) => write(directory, name, value),
    candidate,
    encryptionKey ?? "",
  );
  return {
    ...declared,
    async summary(path: string | undefined, disposition: "complete" | "failed") {
      const text = declared.summary(disposition, latest?.activated ?? []);
      if (path && text) await appendFile(path, text);
    },
    async desired(value: unknown) {
      const identity = Schema.Struct({
        tag: Schema.String.check(Schema.isPattern(/^v[0-9]+(?:\.[0-9]+)+(?:-[a-zA-Z0-9.-]+)?$/u)),
        commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
      });
      const desired = Schema.decodeUnknownSync(
        Schema.Struct({ artifacts: Schema.Struct({ node: identity, home: identity }) }),
      )(value);
      await write(directory, "desired-upstream.json", { candidate, desired: desired.artifacts });
    },
    async admission(verifications: readonly VerificationAdmission[]) {
      await write(directory, "admission.json", { candidate, verifications });
    },
    async serving(value: ServingContainer) {
      await write(directory, "serving.json", value);
    },
    async publication(container: FrozenContainer, normalization?: BaselineNormalization) {
      await write(directory, "publication.json", {
        candidate,
        containers: [describeContainer(container)],
        ...(normalization ? { baselineNormalization: normalization } : {}),
      });
    },
    async manifest(manifest: ReleaseManifest) {
      await write(resolve(directory, "../release-barrier-private"), "frozen.json", {
        schemaVersion: manifest.schemaVersion ?? 1,
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
      if (manifest.schemaVersion === 2) {
        await write(
          directory,
          "container-recovery.sealed.json",
          sealRecovery(
            {
              schemaVersion: 2,
              candidate: manifest.candidate,
              stack: manifest.stack,
              stage: manifest.stage,
              containers: manifest.containers,
              workers: manifest.workers.map(describeWorker),
            },
            encryptionKey ?? "",
            manifest.candidate,
            fingerprint,
          ),
        );
      }
      await write(directory, "manifest.json", {
        candidate: manifest.candidate,
        stack: manifest.stack,
        stage: manifest.stage,
        workers: manifest.workers.map(describeWorker),
        ...(manifest.schemaVersion === 2
          ? { schemaVersion: 2, containers: manifest.containers?.map(describeContainer) }
          : {}),
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
      const refusal =
        error instanceof BarrierRefusal
          ? error
          : operationFailure(error, "(plan)", "release-stack");
      const failure = {
        schemaVersion: 1,
        candidate,
        phase: latest?.phase === "complete" ? "finalize" : (latest?.phase ?? "preparation"),
        ceilingMs: 750,
        manifest: fingerprint ?? null,
        activated: latest?.activated ?? [],
        ...(latest?.pending ? { pending: latest.pending } : {}),
        ...(latest?.pendingUpload ? { pendingUpload: latest.pendingUpload } : {}),
        ...(latest?.containers ? { containers: latest.containers } : {}),
        ...(latest?.pendingContainer ? { pendingContainer: latest.pendingContainer } : {}),
        reason: refusal.reason,
        ...(refusal.stateStore ? { stateStore: refusal.stateStore } : {}),
        ...(refusal instanceof ServingFailure ? { serving: refusal.serving } : {}),
        ...(refusal instanceof ReleaseOperationFailure
          ? { operation: refusal.operation, provider: refusal.provider }
          : {}),
        ...(refusal.worker ? { worker: refusal.worker } : {}),
        ...(refusal.delta ? { delta: refusal.delta } : {}),
        ...(refusal.refusals ? { refusals: refusal.refusals } : {}),
      };
      await write(directory, "failure.json", failure);
      return failure;
    },
  };
}
