import type * as Workers from "@distilled.cloud/cloudflare/workers";
import { havePropsChanged } from "alchemy/Diff";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { changedProps, type PropChange } from "./prop-diff.ts";
import { normalizePlacement, type ActiveWorkerPlacement } from "./script-placement.ts";

export const scriptSettingFields = [
  "limits",
  "placement",
  "observability",
  "logpush",
  "tailConsumers",
  "streamingTailConsumers",
  "tags",
  "localClasses",
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sorted = (items: readonly string[]) => [...new Set(items)].sort();
const classes = (
  bindings: readonly { type: string; className?: string | null; scriptName?: string | null }[],
  name: string,
) =>
  sorted(
    bindings.flatMap((binding) =>
      binding.type === "durable_object_namespace" &&
      binding.className &&
      (!binding.scriptName || binding.scriptName === name)
        ? [binding.className]
        : [],
    ),
  );
const safeScalar = (value: unknown, path: string): string | number | null => {
  if (value == null) return null;
  if (/^placement\.target\.\d+$/.test(path) && Number.isSafeInteger(value) && Number(value) >= 0)
    return Number(value);
  if (
    /^(?:limits\.(?:cpuMs|subrequests)|observability\.(?:headSamplingRate|(?:logs|traces)\.headSamplingRate))$/.test(
      path,
    ) &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  )
    return value;
  if (
    /^(?:logpush|observability\.(?:enabled|redactQueryString|(?:logs|traces|issues)\.(?:enabled|invocationLogs|persist)))$/.test(
      path,
    ) &&
    typeof value === "boolean"
  )
    return String(value);
  if (
    /^placement(?:\.target\.\d+)?\.region$/.test(path) &&
    typeof value === "string" &&
    /^(?:aws|azure|gcp):[a-z0-9-]{1,64}$/.test(value)
  )
    return value;
  if (path === "placement.mode" && ["smart", "targeted", "off"].includes(String(value)))
    return String(value);
  return `sha256:${digest(canonical(value))}`;
};
const at = (value: unknown, path: string) =>
  path
    .split(".")
    .reduce<unknown>(
      (item, key) =>
        item !== null && typeof item === "object" ? Reflect.get(item, key) : undefined,
      value,
    );

export function settingsRefusal(reason: string, worker: string, old: unknown, next: unknown) {
  return new BarrierRefusal(reason, worker, {
    fqn: worker,
    type: "Cloudflare.Worker",
    changed: changedProps(old, next).map((change): PropChange => ({
      path: change.path,
      old: safeScalar(at(old, change.path), change.path),
      new: safeScalar(at(next, change.path), change.path),
    })),
  });
}

function specified(observed: unknown, desired: unknown): unknown {
  if (Array.isArray(desired)) return observed;
  if (record(desired))
    return Object.fromEntries(
      Object.entries(desired)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key,
          specified(record(observed) ? observed[key] : undefined, value),
        ]),
    );
  return observed;
}

/** Compare the complete script-level surface; version-carried code, flags and bindings can change at admission. */
export function assertScriptSettings(
  worker: string,
  scriptName: string,
  metadata: Workers.PutScriptMetadata,
  observed: Workers.GetScriptScriptAndVersionSettingResponse,
  versions: readonly ActiveWorkerPlacement[] = [],
  baseline: readonly { versionId: string }[] = [],
) {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  let placementFailure: string | undefined;
  for (const key of ["limits", "observability"] as const) {
    if (metadata[key] != null) {
      old[key] = specified(observed[key], metadata[key]);
      next[key] = metadata[key];
    }
  }
  if (metadata.placement != null) {
    try {
      old.placement = normalizePlacement(observed.placement, versions, baseline);
      next.placement = normalizePlacement(metadata.placement);
    } catch (error) {
      placementFailure =
        error instanceof Error && error.message === "conflicting-script-placement"
          ? "conflicting-script-placement"
          : "unresolved-script-placement";
      old.placement = observed.placement;
      next.placement = metadata.placement;
    }
  }
  old.logpush = observed.logpush ?? false;
  next.logpush = metadata.logpush ?? false;
  old.tailConsumers = observed.tailConsumers ?? [];
  next.tailConsumers = metadata.tailConsumers ?? [];
  const tags = (values: readonly string[]) =>
    sorted(values.filter((tag) => !tag.startsWith("alchemy:migration-tag:")));
  old.tags = tags(observed.tags ?? []);
  next.tags = tags(metadata.tags ?? []);
  old.localClasses = classes(observed.bindings ?? [], scriptName);
  next.localClasses = classes(metadata.bindings ?? [], scriptName);
  if ((metadata.streamingTailConsumers?.length ?? 0) > 0) {
    old.streamingTailConsumers = [];
    next.streamingTailConsumers = metadata.streamingTailConsumers;
  }
  if (placementFailure || havePropsChanged(old, next)) {
    const reason =
      placementFailure ??
      (havePropsChanged({ value: old.localClasses }, { value: next.localClasses })
        ? "durable-object-class-drift"
        : havePropsChanged({ value: old.tags }, { value: next.tags })
          ? "script-tags-drift"
          : next.streamingTailConsumers
            ? "unobservable-streaming-tail-settings"
            : "script-settings-drift");
    throw settingsRefusal(reason, worker, old, next);
  }
}
