import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Schema } from "effect";
import { canonical, digest } from "./manifest.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";
import { RuntimeResourceName, type RuntimeCreateDeclaration } from "./runtime-create-schema.ts";
import { runtimeModuleExports } from "./provisioning-module.ts";
import { readRuntimeExports } from "./provisioning-exports.ts";

export interface NamespaceBaseline {
  accountId: string;
  scriptName: string;
  version: Workers.GetBetaWorkerVersionResponse;
  containers: NonNullable<Workers.CreateBetaWorkerVersionRequest["containers"]>;
  namespaces: readonly {
    id: string;
    className: string;
    binding: string;
    storage: "sqlite" | "legacy-kv";
  }[];
}
const namespaceRows = Schema.Array(
  Schema.Struct({
    id: Schema.NonEmptyString,
    className: Schema.NonEmptyString,
    binding: Schema.NonEmptyString,
    storage: Schema.Literals(["sqlite", "legacy-kv"]),
  }),
);
const synchronous = <T>(schema: Schema.Schema<T>) => Schema.make<Schema.Codec<T>>(schema.ast);
export const decodeNamespaceBaseline = Schema.decodeUnknownSync(
  Schema.Struct({
    accountId: Schema.NonEmptyString,
    scriptName: Schema.NonEmptyString,
    version: synchronous(Schema.toType(Workers.GetBetaWorkerVersionResponse)),
    containers: synchronous(Schema.toType(Workers.BetaWorkersVersionsCreateRequestContainersList)),
    namespaces: namespaceRows,
  }),
  { onExcessProperty: "error" },
);

/** Version-qualified inheritance retains active bindings; exports and migrations cannot be combined. */
export function runtimeNamespaceRequest(
  baseline: NamespaceBaseline,
  declaration: RuntimeCreateDeclaration,
  operationId: string,
) {
  const source = baseline.version;
  const name = declaration.namespace.className;
  const exports = readRuntimeExports(source.exports);
  if (
    baseline.accountId !== declaration.accountId ||
    !source.id ||
    !source.exports ||
    !source.mainModule ||
    !source.modules?.length ||
    exports[name] ||
    (source.bindings ?? []).some((binding) => binding.name === name) ||
    baseline.containers.some((container) => container.className === name) ||
    baseline.namespaces.some((namespace) => namespace.className === name) ||
    source.urls.length
  )
    throw provisioningRefusal(
      "provisioning-namespace-baseline-unsupported",
      "namespace.baseline",
      `exact-existing-Worker-without-${name}`,
      {
        accountId: baseline.accountId,
        version: source.id,
        exports: source.exports,
        names: (source.bindings ?? []).map((binding) => binding.name),
        urls: source.urls,
      },
    );
  const existingContainers = source.containers ?? [];
  sameProvisioningValue("namespace.containers", baseline.containers, existingContainers);
  for (const namespace of baseline.namespaces) {
    const exported = exports[namespace.className];
    const bound = (source.bindings ?? []).find((binding) => binding.name === namespace.binding);
    if (
      !exported ||
      exported.type !== "durable-object" ||
      exported.storage !== namespace.storage ||
      !bound ||
      bound.type !== "durable_object_namespace" ||
      bound.namespaceId !== namespace.id
    )
      throw provisioningRefusal(
        "provisioning-legacy-namespace-drift",
        "namespace.mapping",
        namespace,
        {
          exported,
          bound,
        },
      );
  }
  const module = `__basalt_runtime_${digest(operationId).slice(0, 16)}.mjs`;
  const main = source.modules.find((part) => part.name === source.mainModule);
  if (
    !main ||
    main.contentType !== "application/javascript+module" ||
    source.modules.some((part) => part.name === module)
  )
    throw provisioningRefusal(
      "provisioning-namespace-module-unsupported",
      "namespace.mainModule",
      "unique-javascript-module",
      source.mainModule,
    );
  const existingExport = runtimeModuleExports(main.name, main.contentBase64, name);
  const suffix = `\nexport { ${name} } from ${JSON.stringify(`./${"../".repeat(source.mainModule.split("/").length - 1)}${module}`)};\n`;
  const modules = source.modules.map((part) =>
    part === main && !existingExport
      ? {
          ...part,
          contentBase64: Buffer.concat([
            Buffer.from(part.contentBase64, "base64"),
            Buffer.from(suffix),
          ]).toString("base64"),
        }
      : { ...part },
  );
  if (!existingExport)
    modules.push({
      name: module,
      contentType: "application/javascript+module",
      contentBase64: Buffer.from(
        `import { DurableObject } from 'cloudflare:workers';\nexport class ${name} extends DurableObject {}\n`,
      ).toString("base64"),
    });
  return Schema.decodeUnknownSync(Schema.toType(Workers.CreateBetaWorkerVersionRequest), {
    onExcessProperty: "error",
  })({
    accountId: baseline.accountId,
    workerId: baseline.scriptName,
    deploy: false,
    annotations: { ...source.annotations, workersMessage: `runtime-provisioning:${operationId}` },
    assets: source.assets ?? undefined,
    bindings: [
      ...(source.bindings ?? []).map((binding) => ({
        type: "inherit",
        name: binding.name,
        versionId: source.id,
      })),
      { type: "durable_object_namespace", name, className: name },
    ],
    cacheOptions: source.cacheOptions ?? undefined,
    compatibilityDate: source.compatibilityDate ?? undefined,
    compatibilityFlags: source.compatibilityFlags ?? undefined,
    containers: [...existingContainers, { className: name }],
    exports: {
      ...exports,
      [name]: {
        type: "durable-object",
        storage: "sqlite",
        container: name,
        state: "created",
      },
    },
    limits: source.limits ?? undefined,
    mainModule: source.mainModule,
    modules,
    placement: source.placement ?? undefined,
    usageModel: source.usageModel ?? undefined,
  });
}

export interface NamespaceObservation {
  accountId: string;
  scriptName: string;
  versionId: string;
  deploymentId: string;
  namespaces: NamespaceBaseline["namespaces"];
  exports: ReturnType<typeof readRuntimeExports>;
  containers: NamespaceBaseline["containers"];
}

export function assertRuntimeNamespace(
  baseline: NamespaceBaseline,
  request: ReturnType<typeof runtimeNamespaceRequest>,
  versionId: string,
  observed: NamespaceObservation,
) {
  sameProvisioningValue(
    "namespace.Worker",
    { accountId: baseline.accountId, scriptName: baseline.scriptName, versionId },
    {
      accountId: observed.accountId,
      scriptName: observed.scriptName,
      versionId: observed.versionId,
    },
  );
  sameProvisioningValue("namespace.exports", request.exports, observed.exports);
  sameProvisioningValue("namespace.containers", request.containers, observed.containers);
  const before = readRuntimeExports(baseline.version.exports);
  const additions = Object.keys(readRuntimeExports(request.exports)).filter(
    (key) => !Object.hasOwn(before, key),
  );
  if (additions.length !== 1 || !Schema.is(RuntimeResourceName)(additions[0]))
    throw provisioningRefusal(
      "provisioning-namespace-unconfirmed",
      "namespace.request",
      "one-runtime-class",
      additions,
    );
  const name = additions[0];
  const added = observed.namespaces.filter(
    (namespace) =>
      namespace.className === name && namespace.binding === name && namespace.storage === "sqlite",
  );
  if (added.length !== 1 || !added[0]!.id || !observed.deploymentId)
    throw provisioningRefusal(
      "provisioning-namespace-unconfirmed",
      "namespace.new",
      "one-observed-container-enabled-SQLite-namespace",
      observed.namespaces,
    );
  sameProvisioningValue(
    "namespace.legacyMappings",
    baseline.namespaces,
    observed.namespaces.filter((namespace) => namespace !== added[0]),
  );
  return { ...observed, namespaceId: added[0]!.id, requestDigest: digest(canonical(request)) };
}
