import type * as Workers from "@distilled.cloud/cloudflare/workers";
import type { PreparedWorkerUpload } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { declaredMismatch } from "./declared-refusal.ts";
import { havePropsChanged } from "alchemy/Diff";
import { canonical, digest, type FrozenWorker } from "./manifest.ts";

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
const refusal = (
  reason: string,
  upload: PreparedWorkerUpload,
  expected: unknown,
  observed: unknown,
) => {
  throw declaredMismatch(reason, upload.fqn, expected, observed, "Cloudflare.Worker");
};
const sorted = (items: readonly string[]) => [...new Set(items)].sort();
const localClasses = (
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

const matchesSpecified = (desired: unknown, observed: unknown): boolean => {
  if (Array.isArray(desired))
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, index) => matchesSpecified(value, observed[index]))
    );
  if (desired !== null && typeof desired === "object")
    return (
      observed !== null &&
      typeof observed === "object" &&
      Object.entries(desired).every(
        ([key, value]) =>
          value === undefined || matchesSpecified(value, Reflect.get(observed, key)),
      )
    );
  return Object.is(desired, observed);
};

/** Versions cannot carry migrations or change script-level settings. Refuse rather than silently omit an intended change. */
export function versionMetadata(upload: PreparedWorkerUpload): Workers.PutScriptMetadata {
  const { metadata, scriptName } = upload.request;
  const observed = upload.previousSettings;
  if (!observed || !upload.previousProps)
    refusal(
      "missing-existing-settings",
      upload,
      { previousSettings: "present", previousProps: "present" },
      {
        previousSettings: observed ? "present" : null,
        previousProps: upload.previousProps ? "present" : null,
      },
    );
  for (const [key, value] of Object.entries(metadata))
    if (value !== undefined && !allowedMetadata.has(key))
      refusal("unsupported-upload-metadata", upload, { [key]: null }, { [key]: value });
  if (metadata.bodyPart != null || metadata.keepBindings != null || metadata.usageModel != null)
    refusal(
      "unsupported-upload-metadata",
      upload,
      { bodyPart: null, keepBindings: null, usageModel: null },
      {
        bodyPart: metadata.bodyPart,
        keepBindings: metadata.keepBindings,
        usageModel: metadata.usageModel,
      },
    );
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
      refusal(
        "durable-object-migration",
        upload,
        {
          migrations: steps.map((step) =>
            Object.fromEntries(
              Object.entries(step)
                .filter(([key]) => !["oldTag", "newTag"].includes(key))
                .map(([key, value]) => [key, Array.isArray(value) ? [] : null]),
            ),
          ),
        },
        {
          migrations: steps.map((step) =>
            Object.fromEntries(
              Object.entries(step).filter(([key]) => !["oldTag", "newTag"].includes(key)),
            ),
          ),
        },
      );
  }
  if (
    canonical(localClasses(metadata.bindings ?? [], scriptName)) !==
    canonical(localClasses(observed!.bindings ?? [], scriptName))
  )
    refusal(
      "durable-object-class-drift",
      upload,
      { localClassSetHash: digest(canonical(localClasses(observed!.bindings ?? [], scriptName))) },
      { localClassSetHash: digest(canonical(localClasses(metadata.bindings ?? [], scriptName))) },
    );
  for (const key of globalProps) {
    if (havePropsChanged({ value: upload.previousProps![key] }, { value: upload.props[key] }))
      refusal(
        "script-settings-change",
        upload,
        { [key]: upload.previousProps![key] },
        { [key]: upload.props[key] },
      );
  }
  const tags = (values: readonly string[]) =>
    sorted(values.filter((tag) => !tag.startsWith("alchemy:migration-tag:")));
  if (canonical(tags(metadata.tags ?? [])) !== canonical(tags(observed!.tags ?? [])))
    refusal(
      "script-tags-drift",
      upload,
      { tags: tags(observed!.tags ?? []) },
      { tags: tags(metadata.tags ?? []) },
    );
  if ((metadata.streamingTailConsumers?.length ?? 0) > 0)
    refusal(
      "unobservable-streaming-tail-settings",
      upload,
      { streamingTailConsumers: [] },
      { streamingTailConsumers: metadata.streamingTailConsumers },
    );
  for (const key of ["limits", "placement", "observability"] as const) {
    if (metadata[key] != null && !matchesSpecified(metadata[key], observed![key]))
      refusal("script-settings-drift", upload, { [key]: observed![key] }, { [key]: metadata[key] });
  }
  if (
    (metadata.logpush ?? false) !== (observed!.logpush ?? false) ||
    havePropsChanged(
      { value: metadata.tailConsumers ?? [] },
      { value: observed!.tailConsumers ?? [] },
    )
  )
    refusal(
      "script-settings-drift",
      upload,
      { logpush: observed!.logpush ?? false, tailConsumers: observed!.tailConsumers ?? [] },
      { logpush: metadata.logpush ?? false, tailConsumers: metadata.tailConsumers ?? [] },
    );
  if (metadata.bindings?.some((binding) => binding.name === "BASALT_RELEASE_ATTEMPT"))
    refusal(
      "attempt-value-in-worker",
      upload,
      { releaseAttemptBindings: { count: 0 } },
      {
        releaseAttemptBindings: {
          count:
            metadata.bindings?.filter((binding) => binding.name === "BASALT_RELEASE_ATTEMPT")
              .length ?? 0,
        },
      },
    );
  return {
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
): Promise<FrozenWorker> {
  const raw = upload.request.files;
  const files = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const metadata = versionMetadata(upload);
  return {
    id: upload.fqn,
    accountId: upload.request.accountId,
    scriptName: upload.request.scriptName,
    sourceMetadata: digest(canonical(upload.request.metadata)),
    metadata: structuredClone(metadata),
    files: await Promise.all(
      files.map(async (file) => {
        if (!(file instanceof File) || !file.name)
          return refusal(
            "unnamed-upload-part",
            upload,
            { uploadPart: "named-File" },
            { uploadPart: file instanceof File ? "empty-name" : "not-File" },
          );
        return {
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }),
    ),
    baseline,
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
