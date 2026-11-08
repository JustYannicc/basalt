import { UpgradeRefusal } from "./refusal.ts";
import type { Candidate, Observation } from "./plan.ts";

const writableAnnotations = new Set([
  "workers/alias",
  "workers/commit_sha",
  "workers/message",
  "workers/pull_request_number",
  "workers/pull_request_title",
  "workers/pull_request_url",
  "workers/repository_url",
  "workers/tag",
]);
export function comparableSettings(settings: Record<string, unknown>) {
  const { annotations, ...rest } = settings;
  if (annotations === null || typeof annotations !== "object" || Array.isArray(annotations))
    return settings;
  const writable = Object.fromEntries(
    Object.entries(annotations).filter(([key]) => key !== "workers/triggered_by"),
  );
  return { ...rest, annotations: writable };
}
/** Version uploads leave script-level placement, limits and observability on the existing script. */
export function uploadMetadata(observed: Observation, candidate: Candidate) {
  const metadata: Record<string, unknown> = {
    main_module: candidate.main,
    bindings: observed.bindings.map(({ name }) => ({ name, type: "inherit" })),
    compatibility_date: observed.runtimeSettings.compatibility_date,
    compatibility_flags: observed.runtimeSettings.compatibility_flags,
  };
  if (observed.runtimeSettings.usage_model !== undefined)
    metadata.usage_model = observed.runtimeSettings.usage_model;
  if (observed.settings.cache_options !== undefined)
    metadata.cache_options = observed.settings.cache_options;
  const annotations = comparableSettings(observed.settings).annotations;
  if (annotations !== undefined && annotations !== null) {
    if (typeof annotations !== "object" || Array.isArray(annotations))
      throw new UpgradeRefusal("alchemy-state-store", "annotations", "object", "invalid");
    const entries = Object.entries(annotations);
    if (
      entries.some(([name, value]) => !writableAnnotations.has(name) || typeof value !== "string")
    )
      throw new UpgradeRefusal(
        "alchemy-state-store",
        "annotations",
        "documented writable fields",
        "unsupported",
      );
    if (entries.length) metadata.annotations = Object.fromEntries(entries);
  }
  return metadata;
}
