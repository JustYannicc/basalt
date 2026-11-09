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

const differences = (
  old: Record<string, string | number>,
  next: Record<string, string | number>,
  prefix: string,
) =>
  Object.keys(old).flatMap((key) =>
    old[key] === next[key] ? [] : [{ path: `${prefix}.${key}`, old: old[key]!, new: next[key]! }],
  );

/** All immutable versions receiving traffic must agree; latest-upload settings are never evidence. */
export function servingWorkerSettings(
  versions: readonly ActiveWorkerPlacement[],
  baseline: readonly { versionId: string; percentage: number }[],
): BaselineWorkerSettings {
  const expected = {
    count: baseline.length,
    identities: baseline
      .map((item) => digest(item.versionId).slice(0, 12))
      .sort()
      .join(","),
    trafficTotal: 100,
    validTraffic: "true",
    uniqueIdentities: "true",
    nonempty: "true",
  };
  const total = baseline.reduce((sum, item) => sum + item.percentage, 0);
  const observed = {
    count: versions.length,
    identities: versions
      .map((item) => digest(item.id).slice(0, 12))
      .sort()
      .join(","),
    trafficTotal: Number.isFinite(total) ? total : "invalid",
    validTraffic: String(
      baseline.every((item) => Number.isFinite(item.percentage) && item.percentage > 0),
    ),
    uniqueIdentities: String(
      new Set(baseline.map((item) => item.versionId)).size === baseline.length &&
        new Set(versions.map((item) => item.id)).size === versions.length,
    ),
    nonempty: String(baseline.length > 0),
  };
  const changed = differences(expected, observed, "servingVersions");
  if (
    !baseline.length ||
    versions.length !== baseline.length ||
    new Set(baseline.map((item) => item.versionId)).size !== baseline.length ||
    baseline.some((item) => !Number.isFinite(item.percentage) || item.percentage <= 0) ||
    total !== 100 ||
    baseline.some(
      (item) => versions.filter((version) => version.id === item.versionId).length !== 1,
    )
  )
    throw new BarrierRefusal("container-baseline-serving-versions-unconfirmed", "PoolWorker", {
      fqn: "PoolWorker",
      type: "Cloudflare.Worker",
      changed,
    });
  const hashes = versions.map(workerInputHash);
  if (hashes.some((hash) => !hash || hash !== hashes[0]))
    throw new BarrierRefusal("container-baseline-serving-bindings-unconfirmed", "PoolWorker", {
      fqn: "PoolWorker",
      type: "Cloudflare.Worker",
      changed: versions.flatMap((version, index) => {
        const bindings =
          version.bindings?.filter((binding) => binding.name === "POOL_IMAGE_HASH") ?? [];
        return differences(
          { count: 1, type: "plain_text", hash: hashes[0] ? safeInputHash(hashes[0]) : "present" },
          {
            count: bindings.length,
            type:
              bindings.length === 1 && bindings[0]?.type === "plain_text"
                ? "plain_text"
                : "missing-or-invalid",
            hash: safeInputHash(hashes[index]),
          },
          `servingVersions.${index}.bindings.POOL_IMAGE_HASH`,
        );
      }),
    });
  return { bindings: [{ name: "POOL_IMAGE_HASH", type: "plain_text", text: hashes[0]! }] };
}
