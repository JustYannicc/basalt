import type * as Workers from "@distilled.cloud/cloudflare/workers";
import { createHash } from "node:crypto";
import type { ResourceDelta } from "./prop-diff.ts";

export interface ModulePart {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

export interface FrozenWorker {
  readonly id: string;
  readonly accountId: string;
  readonly scriptName: string;
  readonly sourceMetadata?: string;
  readonly metadata: Readonly<Workers.PutScriptMetadata>;
  readonly files: readonly ModulePart[];
  readonly baseline: readonly { versionId: string; percentage: number }[];
}

export interface ReleaseManifest {
  readonly candidate: string;
  readonly stack: string;
  readonly stage: string;
  readonly workers: readonly FrozenWorker[];
}

export type PlanRefusal = { reason: string } | ({ reason: string } & ResourceDelta);

export class BarrierRefusal extends Error {
  readonly reason: string;
  readonly worker: string | undefined;
  readonly delta: ResourceDelta | undefined;
  readonly refusals: readonly PlanRefusal[] | undefined;

  constructor(
    reason: string,
    worker?: string,
    delta?: ResourceDelta,
    refusals?: readonly PlanRefusal[],
  ) {
    super(`Release barrier refused: ${reason}${worker ? ` (${worker})` : ""}`);
    this.reason = reason;
    this.worker = worker;
    this.delta = delta;
    this.refusals = refusals;
  }
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new BarrierRefusal("unsupported-manifest-value");
}

export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export function describeWorker(worker: FrozenWorker) {
  return {
    id: worker.id,
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
    }),
  );
}

export function assertManifest(manifest: ReleaseManifest) {
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
    workers: manifest.workers.map((worker) => ({
      ...worker,
      metadata: structuredClone(worker.metadata),
      files: worker.files.map((file) => ({ ...file, bytes: new Uint8Array(file.bytes) })),
      baseline: worker.baseline.map((item) => ({ ...item })),
    })),
  };
}
