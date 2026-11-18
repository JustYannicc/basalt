import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Schema } from "effect";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

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

/**
 * The namespace a new application attaches to. PoolWorker's Durable Object classes and
 * migrations have one writer, the alchemy deploy, so a bootstrap never uploads the Worker:
 * it only resolves the class that deploy already created.
 */
export interface NamespaceAttachment {
  accountId: string;
  scriptName: string;
  versionId: string;
  className: string;
  binding: string;
  namespaceId: string;
}

/** Pure: the existing, not yet container-backed SQLite namespace this declaration attaches to. */
export function runtimeNamespaceAttachment(
  baseline: NamespaceBaseline,
  declaration: { accountId: string; namespace: { className: string; binding: string } },
): NamespaceAttachment {
  const source = baseline.version;
  const { className, binding } = declaration.namespace;
  const owned = baseline.namespaces.filter((namespace) => namespace.className === className);
  const bound = (source.bindings ?? []).filter((item) => item.name === binding);
  const containerBacked =
    baseline.containers.some((container) => container.className === className) ||
    (source.containers ?? []).some((container) => container.className === className);
  if (
    baseline.accountId !== declaration.accountId ||
    !source.id ||
    owned.length !== 1 ||
    owned[0]!.binding !== binding ||
    owned[0]!.storage !== "sqlite" ||
    bound.length !== 1 ||
    bound[0]!.type !== "durable_object_namespace" ||
    bound[0]!.className !== className ||
    bound[0]!.namespaceId !== owned[0]!.id ||
    containerBacked
  )
    throw provisioningRefusal(
      "provisioning-namespace-baseline-unsupported",
      "namespace.baseline",
      `deployed-SQLite-class-${className}-without-container`,
      {
        accountId: baseline.accountId,
        version: source.id,
        namespaces: owned.length,
        bindings: bound.length,
        storage: owned[0]?.storage ?? null,
        containerBacked,
      },
    );
  sameProvisioningValue("namespace.containers", baseline.containers, source.containers ?? []);
  return {
    accountId: baseline.accountId,
    scriptName: baseline.scriptName,
    versionId: source.id,
    className,
    binding,
    namespaceId: owned[0]!.id,
  };
}

export interface NamespaceObservation {
  accountId: string;
  scriptName: string;
  versionId: string;
  deploymentId: string;
  namespaces: NamespaceBaseline["namespaces"];
  containers: NamespaceBaseline["containers"];
}

/** The application create still targets exactly the namespace the frozen attachment named. */
export function assertNamespaceAttachment(
  attachment: NamespaceAttachment,
  baseline: NamespaceBaseline,
  observed: NamespaceObservation,
) {
  sameProvisioningValue(
    "namespace.Worker",
    {
      accountId: attachment.accountId,
      scriptName: attachment.scriptName,
      versionId: attachment.versionId,
    },
    {
      accountId: observed.accountId,
      scriptName: observed.scriptName,
      versionId: observed.versionId,
    },
  );
  sameProvisioningValue("namespace.mappings", baseline.namespaces, observed.namespaces);
  sameProvisioningValue("namespace.containers", baseline.containers, observed.containers);
  return attachment;
}
