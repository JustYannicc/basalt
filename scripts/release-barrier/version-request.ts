import type * as Workers from "@distilled.cloud/cloudflare/workers";
import type { PreparedWorkerUpload } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { havePropsChanged } from "alchemy/Diff";
import { assertScriptSettings, settingsRefusal } from "./script-settings.ts";
import type { ActiveWorkerPlacement } from "./script-placement.ts";
import { BarrierRefusal, canonical, digest, type FrozenWorker } from "./manifest.ts";
import { repairComparisonSettings, type PendingPlacementRepair } from "./pending-placement.ts";

const globalProps = [
  "observability",
  "limits",
  "placement",
  "logpush",
  "tailConsumers",
  "streamingTailConsumers",
  "tags",
] as const;
const allowedMetadata = new Set([
  "annotations",
  "assets",
  "bindings",
  "bodyPart",
  "cacheOptions",
  "compatibilityDate",
  "compatibilityFlags",
  "containers",
  "keepAssets",
  "keepBindings",
  "limits",
  "logpush",
  "mainModule",
  "migrations",
  "observability",
  "placement",
  "tags",
  "tailConsumers",
  "streamingTailConsumers",
  "usageModel",
]);
const refusal = (reason: string, upload: PreparedWorkerUpload) => {
  throw new BarrierRefusal(reason, upload.fqn);
};
/** Versions cannot carry migrations or change script-level settings. Refuse rather than silently omit an intended change. */
export function versionMetadata(
  upload: PreparedWorkerUpload,
  versions: readonly ActiveWorkerPlacement[] = [],
  baseline: readonly { versionId: string }[] = [],
  repair?: PendingPlacementRepair,
): Workers.PutScriptMetadata {
  const { metadata, scriptName } = upload.request;
  const observed = upload.previousSettings;
  if (!observed || !upload.previousProps) refusal("missing-existing-settings", upload);
  for (const [key, value] of Object.entries(metadata))
    if (value !== undefined && !allowedMetadata.has(key))
      refusal("unsupported-upload-metadata", upload);
  if (metadata.bodyPart != null || metadata.keepBindings != null || metadata.usageModel != null)
    refusal("unsupported-upload-metadata", upload);
  const migrations = metadata.migrations;
  if (migrations) {
    const steps = "steps" in migrations ? (migrations.steps ?? []) : [migrations];
    if (
      steps.some((step) =>
        Object.entries(step).some(
          ([key, value]) =>
            !["newTag", "oldTag"].includes(key) &&
            value != null &&
            (!Array.isArray(value) || value.length),
        ),
      )
    )
      refusal("durable-object-migration", upload);
  }
  const changed = globalProps.filter((key) =>
    havePropsChanged({ value: upload.previousProps![key] }, { value: upload.props[key] }),
  );
  if (changed.length)
    throw settingsRefusal(
      "script-settings-change",
      upload.fqn,
      Object.fromEntries(changed.map((key) => [key, upload.previousProps![key]])),
      Object.fromEntries(changed.map((key) => [key, upload.props[key]])),
    );
  assertScriptSettings(
    upload.fqn,
    scriptName,
    metadata,
    repair ? repairComparisonSettings(observed!, repair) : observed!,
    versions,
    baseline,
  );
  if (metadata.bindings?.some((binding) => binding.name === "BASALT_RELEASE_ATTEMPT"))
    refusal("attempt-value-in-worker", upload);
  return {
    // Placement is version-scoped even when declarations are unchanged.
    placement: metadata.placement,
    limits: metadata.limits,
    observability: metadata.observability,
    annotations: metadata.annotations,
    mainModule: metadata.mainModule,
    bindings: metadata.bindings,
    containers: metadata.containers,
    compatibilityDate: metadata.compatibilityDate,
    compatibilityFlags: metadata.compatibilityFlags,
    // keep_assets preserves files; assets.config preserves how those files are served.
    assets: metadata.assets,
    keepAssets: metadata.keepAssets,
    cacheOptions: metadata.cacheOptions,
  };
}

export async function freezeUpload(
  upload: PreparedWorkerUpload,
  baseline: FrozenWorker["baseline"],
  versions: readonly ActiveWorkerPlacement[] = [],
  repair?: PendingPlacementRepair,
): Promise<FrozenWorker> {
  const raw = upload.request.files;
  const files = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const metadata = versionMetadata(upload, versions, baseline, repair);
  const baselineBinding =
    upload.fqn === "PoolWorker"
      ? upload.previousSettings?.bindings?.find(
          (binding) => binding.name === "POOL_IMAGE_HASH" && binding.type === "plain_text",
        )
      : undefined;
  return {
    id: upload.fqn,
    accountId: upload.request.accountId,
    scriptName: upload.request.scriptName,
    sourceMetadata: digest(canonical(upload.request.metadata)),
    metadata: structuredClone(metadata),
    files: await Promise.all(
      files.map(async (file) => {
        if (!(file instanceof File) || !file.name) return refusal("unnamed-upload-part", upload);
        return {
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }),
    ),
    baseline,
    ...(baselineBinding?.type === "plain_text" && baselineBinding.text
      ? { baselineImageHash: baselineBinding.text }
      : {}),
    ...(repair ? { pendingPlacementRepair: repair } : {}),
  };
}

export function uploadRequest(worker: FrozenWorker): Workers.CreateScriptVersionRequest {
  return {
    accountId: worker.accountId,
    scriptName: worker.scriptName,
    bindingsInherit: "strict",
    metadata: worker.metadata,
    files: worker.files.map(
      (file) => new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
    ),
  };
}
