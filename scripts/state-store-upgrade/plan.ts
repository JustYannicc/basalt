import { digest, bytesDigest } from "./encoding.ts";
import { UpgradeRefusal, differences, bindingDifferences, refuseChanges } from "./refusal.ts";

export const workerId = "alchemy-state-store";
export const targetVersion = 8;
export type Binding = Record<string, unknown> & { name: string; type: string };
export interface Observation {
  accountId: string;
  workerId: string;
  protocol: number;
  deploymentId: string;
  versionId: string;
  latestVersionId: string;
  settings: Record<string, unknown>;
  runtimeSettings: Record<string, unknown>;
  bindings: Binding[];
  servingBindings: Binding[];
  namespace: { id: string; class: string; script: string; use_sqlite: boolean };
  encryptionKey: Record<string, unknown>;
}
export interface Candidate {
  main: string;
  compatibility: { date: string; flags: string[] };
  files: { name: string; type: string; bytes: Uint8Array }[];
}
export interface Expected {
  workerId: string;
  deploymentId: string;
  namespaceId: string;
  version: string;
  planSha256: string;
}

export { UpgradeRefusal } from "./refusal.ts";
export { canonical, digest, bytesDigest } from "./encoding.ts";
const same = (
  resource: string,
  property: string,
  expected: string | number,
  observed: string | number,
) => {
  if (expected !== observed) throw new UpgradeRefusal(resource, property, expected, observed);
};
export const bindingDigest = (bindings: readonly Binding[]) =>
  digest([...bindings].sort((a, b) => a.name.localeCompare(b.name)));

export function assertBaseline(observed: Observation, protocol = 7) {
  same(workerId, "worker-id", workerId, observed.workerId);
  same(workerId, "state-store-version", protocol, observed.protocol);
  same(workerId, "latest-uploaded-version", observed.versionId, observed.latestVersionId);
  same("Store", "class", "Store", observed.namespace.class);
  same("Store", "script", workerId, observed.namespace.script);
  same("Store", "storage", "sqlite", observed.namespace.use_sqlite ? "sqlite" : "other");
  const names = observed.bindings.map((binding) => binding.name);
  same(workerId, "unique-binding-names", names.length, new Set(names).size);
  const stores = observed.bindings.filter((binding) => binding.type === "durable_object_namespace");
  same(workerId, "durable-object-bindings", 1, stores.length);
  same("Store", "binding-name", "Store", String(stores[0]?.name));
  same("Store", "namespace-id", observed.namespace.id, String(stores[0]?.namespace_id));
  same("Store", "binding-class", "Store", String(stores[0]?.class_name));
  for (const binding of observed.bindings) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.name))
      throw new UpgradeRefusal(workerId, "binding-name", "identifier", "invalid");
    if (!["plain_text", "secrets_store_secret", "durable_object_namespace"].includes(binding.type))
      throw new UpgradeRefusal(
        binding.name,
        "binding-type",
        "supported existing binding",
        "unsupported",
      );
  }
  for (const name of ["AlchemyStateStoreToken", "StateStoreEncryptionKey"]) {
    const binding = observed.bindings.find((item) => item.name === name);
    same(name, "binding-type", "secrets_store_secret", binding?.type ?? "missing");
  }
}

export function makePlan(observed: Observation, candidate: Candidate) {
  assertBaseline(observed);
  refuseChanges(bindingDifferences(observed.servingBindings, observed.bindings));
  same(
    workerId,
    "immutable-compatibility-date",
    String(observed.runtimeSettings.compatibility_date),
    candidate.compatibility.date,
  );
  same(
    workerId,
    "immutable-compatibility-flags-sha256",
    digest(observed.runtimeSettings.compatibility_flags),
    digest(candidate.compatibility.flags),
  );
  same(
    workerId,
    "compatibility-date",
    String(observed.settings.compatibility_date),
    candidate.compatibility.date,
  );
  same(
    workerId,
    "compatibility-flags-sha256",
    digest(observed.settings.compatibility_flags),
    digest(candidate.compatibility.flags),
  );
  return {
    schemaVersion: 1,
    operation: "state-store-code-upgrade",
    accountId: observed.accountId,
    workerId,
    fromVersion: observed.protocol,
    toVersion: targetVersion,
    deploymentId: observed.deploymentId,
    priorWorkerVersionId: observed.versionId,
    namespace: observed.namespace,
    encryptionKeyIdentitySha256: digest(observed.encryptionKey),
    settingsSha256: digest(observed.settings),
    runtimeSettingsSha256: digest(observed.runtimeSettings),
    bindingsSha256: bindingDigest(observed.bindings),
    bindings: [...observed.bindings]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((binding) => ({
        name: binding.name,
        type: binding.type,
        change: "unchanged",
        identitySha256: digest(binding),
        ...Object.fromEntries(
          ["class_name", "namespace_id", "secret_name", "store_id"].flatMap((key) =>
            typeof binding[key] === "string" ? [[key, binding[key]]] : [],
          ),
        ),
      })),
    candidate: {
      main: candidate.main,
      compatibility: candidate.compatibility,
      files: candidate.files
        .map((file) => ({
          name: file.name,
          type: file.type,
          bytes: file.bytes.length,
          sha256: bytesDigest(file.bytes),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
    changes: ["upload one Worker code version", "activate that version at 100 percent"],
    unchanged: [
      "all Worker settings",
      "every binding",
      "Store namespace",
      "encryption key identity",
    ],
    secretsStore: "No Secrets Store resource is created, updated or deleted.",
    durableObjectMigrations: 0,
    stateContentRequests: 0,
  };
}
export type Plan = ReturnType<typeof makePlan>;

export function assertExpected(observed: Observation, plan: Plan, expected: Expected) {
  const checks = [
    ["worker-id", observed.workerId, expected.workerId],
    ["deployment-id", observed.deploymentId, expected.deploymentId],
    ["namespace-id", observed.namespace.id, expected.namespaceId],
    ["state-store-version", "7", expected.version],
    ["plan-sha256", digest(plan), expected.planSha256],
  ];
  for (const [property, actual, supplied] of checks) {
    if (!supplied || !/^[A-Za-z0-9_-]{1,128}$/.test(supplied))
      throw new UpgradeRefusal(
        workerId,
        `input-${property}`,
        "explicit valid input",
        "missing-or-invalid",
      );
    same(workerId, property!, supplied, actual!);
  }
}

export function assertUnchanged(before: Observation, after: Observation, version: number) {
  const { bindings: _beforeBindings, ...beforeSettings } = before.settings;
  const { bindings: _afterBindings, ...afterSettings } = after.settings;
  refuseChanges([
    ...differences(
      workerId,
      { protocol: version, workerId: before.workerId },
      { protocol: after.protocol, workerId: after.workerId },
    ),
    ...differences("Store", before.namespace, after.namespace),
    ...differences("StateStoreEncryptionKey", before.encryptionKey, after.encryptionKey),
    ...differences(workerId, beforeSettings, afterSettings),
    ...differences(`${workerId} runtime`, before.runtimeSettings, after.runtimeSettings),
    ...bindingDifferences(before.bindings, after.bindings),
    ...bindingDifferences(before.servingBindings, after.servingBindings),
  ]);
}

/** Strict inheritance copies existing bindings without sending secrets or assigning a namespace. */
export function uploadMetadata(observed: Observation, candidate: Candidate) {
  const metadata: Record<string, unknown> = {
    main_module: candidate.main,
    bindings: observed.bindings.map(({ name }) => ({ name, type: "inherit" })),
  };
  for (const key of [
    "compatibility_date",
    "compatibility_flags",
    "placement",
    "limits",
    "observability",
    "annotations",
    "cache_options",
  ])
    if (observed.settings[key] !== undefined) metadata[key] = observed.settings[key];
  for (const key of ["compatibility_date", "compatibility_flags", "limits", "placement"])
    if (observed.runtimeSettings[key] !== undefined) metadata[key] = observed.runtimeSettings[key];
  return metadata;
}
