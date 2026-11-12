import { canonicalProviderValue } from "../../src/pool/runtime-provider/canonical.ts";
import type { PendingPlacementRepair } from "./pending-placement.ts";
import type * as Workers from "@distilled.cloud/cloudflare/workers";
import { createHash } from "node:crypto";
import { describeContainer, type FrozenContainer } from "./container.ts";
import { BarrierRefusal } from "./refusal.ts";
export { BarrierRefusal, type PlanRefusal } from "./refusal.ts";

export interface ModulePart {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

export interface FrozenWorker {
  readonly id: string;
  readonly baselineImageHash?: string;
  readonly pendingPlacementRepair?: PendingPlacementRepair;
  readonly accountId: string;
  readonly scriptName: string;
  readonly sourceMetadata?: string;
  readonly metadata: Readonly<Workers.PutScriptMetadata>;
  readonly files: readonly ModulePart[];
  readonly baseline: readonly { versionId: string; percentage: number }[];
}

export interface ReleaseManifest {
  readonly schemaVersion?: 2;
  readonly candidate: string;
  readonly stack: string;
  readonly stage: string;
  readonly workers: readonly FrozenWorker[];
  readonly containers?: readonly FrozenContainer[];
}

export function canonical(value: unknown): string {
  try {
    return canonicalProviderValue(value);
  } catch {
    throw new BarrierRefusal("unsupported-manifest-value");
  }
}

export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export function describeWorker(worker: FrozenWorker) {
  return {
    id: worker.id,
    ...(worker.baselineImageHash ? { baselineImageHash: worker.baselineImageHash } : {}),
    ...(worker.pendingPlacementRepair
      ? { pendingPlacementRepair: worker.pendingPlacementRepair }
      : {}),
    target: digest(canonical({ accountId: worker.accountId, scriptName: worker.scriptName })),
    sourceMetadata: worker.sourceMetadata,
    metadata: digest(canonical(worker.metadata)),
    files: worker.files.map((file) => ({
      name: file.name,
      type: file.type,
      bytes: file.bytes.byteLength,
      sha256: digest(file.bytes),
    })),
    baseline: worker.baseline,
  };
}

export function manifestDigest(manifest: ReleaseManifest) {
  return digest(
    canonical({
      candidate: manifest.candidate,
      stack: manifest.stack,
      stage: manifest.stage,
      workers: manifest.workers.map(describeWorker),
      ...(manifest.schemaVersion === 2
        ? { schemaVersion: 2, containers: manifest.containers?.map(describeContainer) }
        : {}),
    }),
  );
}

export function assertManifest(manifest: ReleaseManifest) {
  if (
    (manifest.containers?.length && manifest.schemaVersion !== 2) ||
    (manifest.schemaVersion === 2 && manifest.containers?.length !== 1)
  )
    throw new BarrierRefusal("invalid-container-manifest");
  if (
    !/^[a-f0-9]{40}$/.test(manifest.candidate) ||
    !manifest.stack ||
    !manifest.stage ||
    !manifest.workers.length
  )
    throw new BarrierRefusal("invalid-manifest");
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const worker of manifest.workers) {
    const target = canonical([worker.accountId, worker.scriptName]);
    if (!worker.id || ids.has(worker.id) || targets.has(target))
      throw new BarrierRefusal("duplicate-worker", worker.id);
    ids.add(worker.id);
    targets.add(target);
    if (!worker.accountId || !worker.scriptName || !worker.files.length || !worker.baseline.length)
      throw new BarrierRefusal("missing-worker-input", worker.id);
    const names = new Set<string>();
    for (const file of worker.files) {
      if (!file.name || names.has(file.name) || !file.type)
        throw new BarrierRefusal("invalid-module", worker.id);
      names.add(file.name);
    }
    if (typeof worker.metadata.mainModule !== "string" || !names.has(worker.metadata.mainModule))
      throw new BarrierRefusal("missing-entry-module", worker.id);
    if (
      worker.baseline.some(
        (item) => !item.versionId || !Number.isFinite(item.percentage) || item.percentage <= 0,
      ) ||
      worker.baseline.reduce((sum, item) => sum + item.percentage, 0) !== 100
    )
      throw new BarrierRefusal("invalid-baseline", worker.id);
  }
  manifestDigest(manifest);
}

export function snapshotManifest(manifest: ReleaseManifest): ReleaseManifest {
  assertManifest(manifest);
  return {
    candidate: manifest.candidate,
    stack: manifest.stack,
    stage: manifest.stage,
    ...(manifest.schemaVersion === 2
      ? { schemaVersion: 2, containers: structuredClone(manifest.containers) }
      : {}),
    workers: manifest.workers.map((worker) => ({
      ...worker,
      metadata: structuredClone(worker.metadata),
      files: worker.files.map((file) => ({ ...file, bytes: new Uint8Array(file.bytes) })),
      baseline: worker.baseline.map((item) => ({ ...item })),
    })),
  };
}
