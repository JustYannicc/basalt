import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Schema } from "effect";
import { readRuntimeExports } from "./provisioning-exports.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { changedProps } from "./prop-diff.ts";
import type { FirstHandoffManifest, HandoffWorkerSnapshot } from "./first-handoff-contract.ts";

export function handoffWorkerRefusal(
  reason: string,
  path: string,
  expected: unknown,
  observed: unknown,
) {
  return new BarrierRefusal(reason, "PoolWorker", {
    fqn: "PoolWorker",
    type: "Cloudflare.Worker",
    changed: changedProps(expected, observed, (old, next) => ({
      old: digest(canonical(old ?? null)),
      new: digest(canonical(next ?? null)),
    })).map((change) => ({
      ...change,
      path: change.path === "$" ? path : `${path}.${change.path}`,
    })),
    why: [
      "The exact immutable version and preserved settings must match before relying on the next handoff phase.",
    ],
  });
}
export function sameHandoffWorkerValue(path: string, expected: unknown, observed: unknown) {
  if (canonical(expected ?? null) !== canonical(observed ?? null))
    throw handoffWorkerRefusal("first-handoff-worker-drift", path, expected, observed);
}

export type HandoffVersionRequest = Workers.CreateBetaWorkerVersionRequest;
export type HandoffVersion = Workers.GetBetaWorkerVersionResponse;
export interface FirstHandoffWorker {
  observe(): Promise<HandoffWorkerSnapshot>;
  stage(request: HandoffVersionRequest): Promise<{ versionId: string; startupTimeMs: number }>;
  version(versionId: string): Promise<HandoffVersion>;
  activate(versionId: string): Promise<{ deploymentId: string }>;
}

function runtimeBindings(manifest: FirstHandoffManifest) {
  const c = manifest.candidate.configuration;
  const values = {
    POOL_IMAGE_HASH: c.imageInput,
    POOL_DATABASE_URL: c.databaseUrl,
    POOL_MANAGEMENT_KEY: c.managementKey,
    POOL_APP_SIGNING_KEY: c.signingKey,
    ...(c.previousSigningKey ? { POOL_APP_SIGNING_KEY_PREVIOUS: c.previousSigningKey } : {}),
    POOL_RUNTIME_APPLICATION_ID: manifest.candidate.target.applicationId,
  };
  return Object.entries(values).map(([name, text]) => ({
    type:
      name === "POOL_IMAGE_HASH" || name === "POOL_RUNTIME_APPLICATION_ID"
        ? ("plain_text" as const)
        : ("secret_text" as const),
    name,
    text,
  }));
}
const runtimeNames = new Set([
  "POOL_IMAGE_HASH",
  "POOL_DATABASE_URL",
  "POOL_MANAGEMENT_KEY",
  "POOL_APP_SIGNING_KEY",
  "POOL_APP_SIGNING_KEY_PREVIOUS",
  "POOL_RUNTIME_APPLICATION_ID",
]);

/** Code installation and current-runtime configuration are different immutable versions. */
export function firstHandoffVersionRequest(
  manifest: FirstHandoffManifest,
  phase: "preserve" | "advance",
) {
  const { baseline } = manifest;
  const source = baseline.version;
  const exports = readRuntimeExports(source.exports);
  const bindings = source.bindings ?? [];
  const image = bindings.find((binding) => binding.name === "POOL_IMAGE_HASH");
  for (const [className, runtime] of [
    ["PoolContainer", manifest.legacy],
    ["PoolRuntime", manifest.candidate],
  ] as const) {
    const binding = bindings.find((binding) => binding.name === className);
    const exported = exports[className];
    if (
      binding?.type !== "durable_object_namespace" ||
      binding.className !== className ||
      binding.namespaceId !== runtime.provider.namespaceId ||
      (binding.scriptName && binding.scriptName !== baseline.scriptName) ||
      !exported ||
      exported.type !== "durable-object" ||
      exported.storage !== "sqlite" ||
      exported.container !== className ||
      source.containers?.filter((container) => container.className === className).length !== 1
    )
      throw handoffWorkerRefusal(
        "first-handoff-namespace-mismatch",
        `firstHandoff.Worker.${className}`,
        "exact-provisioned-local-container-namespace",
        "unverified",
      );
  }
  const legacyApplication = bindings.find(
    (binding) => binding.name === "POOL_CONTAINER_APPLICATION_ID",
  );
  if (
    legacyApplication?.type !== "plain_text" ||
    legacyApplication.text !== manifest.legacy.target.applicationId
  )
    throw handoffWorkerRefusal(
      "first-handoff-legacy-application-mismatch",
      "firstHandoff.Worker.POOL_CONTAINER_APPLICATION_ID",
      manifest.legacy.target.applicationId,
      "unverified",
    );
  if (
    !source.id ||
    source.urls.length ||
    !exports.PoolContainer ||
    !exports.PoolRuntime ||
    new Set(bindings.map((binding) => binding.name)).size !== bindings.length ||
    image?.type !== "plain_text" ||
    image.text !== manifest.legacy.target.imageInput
  )
    throw handoffWorkerRefusal(
      "first-handoff-baseline-unsupported",
      "firstHandoff.Worker.baseline",
      "pinned-legacy-image-and-existing-runtime-classes",
      "unverified",
    );
  const overrides = phase === "advance" ? runtimeBindings(manifest) : [];
  return Schema.decodeUnknownSync(Schema.toType(Workers.CreateBetaWorkerVersionRequest), {
    onExcessProperty: "error",
  })({
    accountId: baseline.accountId,
    workerId: baseline.scriptName,
    deploy: false,
    annotations: {
      ...source.annotations,
      workersMessage: `first-handoff:${manifest.legacy.operationId}:${phase}`,
    },
    assets: source.assets ?? undefined,
    bindings: [
      ...bindings
        .filter((binding) => !overrides.length || !runtimeNames.has(binding.name))
        .map((binding) => ({ type: "inherit", name: binding.name, versionId: source.id })),
      ...overrides,
    ],
    cacheOptions: source.cacheOptions ?? undefined,
    compatibilityDate: source.compatibilityDate ?? undefined,
    compatibilityFlags: source.compatibilityFlags ?? undefined,
    containers: source.containers ?? undefined,
    exports,
    limits: source.limits ?? undefined,
    mainModule: manifest.mainModule,
    modules: manifest.modules,
    packageDependencies: source.packageDependencies ?? undefined,
    placement: source.placement ?? undefined,
    usageModel: source.usageModel ?? undefined,
  });
}

export function assertHandoffVersion(
  manifest: FirstHandoffManifest,
  request: HandoffVersionRequest,
  version: HandoffVersion,
  versionId: string,
) {
  sameHandoffWorkerValue("firstHandoff.Worker.version", versionId, version.id);
  for (const field of [
    "mainModule",
    "modules",
    "exports",
    "containers",
    "compatibilityDate",
    "compatibilityFlags",
    "limits",
    "placement",
    "cacheOptions",
    "assets",
    "usageModel",
    "packageDependencies",
  ] as const)
    sameHandoffWorkerValue(
      `firstHandoff.Worker.${field}`,
      request[field] ?? null,
      version[field] ?? null,
    );
  const before = manifest.baseline.version.bindings ?? [];
  const expected = (request.bindings ?? []).map((binding) =>
    binding.type === "inherit" ? before.find((old) => old.name === binding.name) : binding,
  );
  const actual = version.bindings ?? [];
  sameHandoffWorkerValue(
    "firstHandoff.Worker.bindingNames",
    expected.map((b) => b?.name).sort(),
    actual.map((b) => b.name).sort(),
  );
  for (const binding of expected) {
    if (!binding)
      throw handoffWorkerRefusal(
        "first-handoff-inheritance-unverified",
        "firstHandoff.Worker.bindings",
        "frozen-binding",
        null,
      );
    const observed = actual.find((b) => b.name === binding.name);
    // Provider reads redact secrets. The accepted version pins their write; the actual startup witness verifies their values.
    if (
      binding.type === "secret_text" &&
      observed?.type === "secret_text" &&
      observed.text === undefined
    )
      sameHandoffWorkerValue(
        `firstHandoff.Worker.binding.${binding.name}`,
        { name: binding.name, type: binding.type },
        observed,
      );
    else sameHandoffWorkerValue(`firstHandoff.Worker.binding.${binding.name}`, binding, observed);
  }
  if (
    !Number.isFinite(version.startupTimeMs) ||
    version.startupTimeMs! < 0 ||
    version.startupTimeMs! > 750
  )
    throw handoffWorkerRefusal(
      "first-handoff-startup-unverified",
      "firstHandoff.Worker.startupTimeMs",
      "0..750",
      version.startupTimeMs ?? null,
    );
}
