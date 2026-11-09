import { BarrierRefusal, digest } from "./manifest.ts";
import type { ActiveWorkerPlacement } from "./script-placement.ts";

export interface BaselineWorkerSettings {
  bindings?: readonly { name: string; type: string; text?: string }[] | null;
}

export const safeInputHash = (value: string | undefined) =>
  value === undefined
    ? "missing"
    : /^[a-f0-9]{16,64}$/.test(value)
      ? value.slice(0, 12)
      : `sha256:${digest(value).slice(0, 12)}`;

export function workerInputHash(settings: BaselineWorkerSettings | undefined) {
  const bindings =
    settings?.bindings?.filter((binding) => binding.name === "POOL_IMAGE_HASH") ?? [];
  return bindings.length === 1 && bindings[0]?.type === "plain_text" && bindings[0].text
    ? bindings[0].text
    : undefined;
}

/** All immutable versions receiving traffic must agree; latest-upload settings are never evidence. */
export function servingWorkerSettings(
  versions: readonly ActiveWorkerPlacement[],
  baseline: readonly { versionId: string; percentage: number }[],
): BaselineWorkerSettings {
  if (
    !baseline.length ||
    versions.length !== baseline.length ||
    new Set(baseline.map((item) => item.versionId)).size !== baseline.length ||
    baseline.some((item) => !Number.isFinite(item.percentage) || item.percentage <= 0) ||
    baseline.reduce((total, item) => total + item.percentage, 0) !== 100 ||
    baseline.some(
      (item) => versions.filter((version) => version.id === item.versionId).length !== 1,
    )
  )
    throw new BarrierRefusal("container-baseline-serving-versions-unconfirmed", "PoolWorker");
  const hashes = versions.map(workerInputHash);
  if (hashes.some((hash) => !hash || hash !== hashes[0]))
    throw new BarrierRefusal("container-baseline-serving-bindings-unconfirmed", "PoolWorker", {
      fqn: "PoolWorker",
      type: "Cloudflare.Worker",
      changed: versions.map((version, index) => ({
        path: `servingVersions.${index}.bindings.POOL_IMAGE_HASH`,
        old: safeInputHash(hashes[0]),
        new: safeInputHash(hashes[index]),
      })),
    });
  return { bindings: [{ name: "POOL_IMAGE_HASH", type: "plain_text", text: hashes[0]! }] };
}
