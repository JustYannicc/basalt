import { canonical, digest } from "../manifest.ts";
import { runtimeNamespaceAttachment } from "../provisioning-namespace.ts";
import {
  decodeProvisioningManifest,
  provisioningManifestDigest,
} from "../provisioning-contract.ts";
import { applicationTemplateDigest, expectedApplicationRequest } from "../provisioning-wire.ts";
import { decodeRuntimeCreate, type RuntimeResourceName } from "../runtime-create-schema.ts";
import { decodeNamespaceBaseline } from "../provisioning-namespace.ts";
export const runtimeDeclaration = (name: RuntimeResourceName = "PoolRuntime") =>
  decodeRuntimeCreate({
    action: "create-container",
    type: "Cloudflare.Container",
    fqn: name,
    disposition: "provision-only",
    baseline: "absent",
    accountId: "1".repeat(32),
    instanceId: "2".repeat(32),
    namespace: { workerFqn: "PoolWorker", className: name, binding: name },
    props: {
      name: "synthetic-runtime",
      className: name,
      image: `registry.cloudflare.com/${"1".repeat(32)}/synthetic@sha256:${"a".repeat(64)}`,
      instanceType: "basic",
      instances: 0,
      maxInstances: name === "PoolRuntime" ? 1 : 4,
      schedulingPolicy: "default",
      constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
      observability: { logs: { enabled: true } },
    },
    publication: {
      inputHash: "b".repeat(16),
      imageConfigDigest: `sha256:${"c".repeat(64)}`,
      platform: "linux/amd64",
      capabilityLabel: "1",
    },
    sdkSourceDigest: "d".repeat(64),
    removalPolicy: "retain",
    retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
  });
const runtimeClasses = ["PoolRuntime", "PoolRuntimeBlue", "PoolRuntimeGreen"] as const;
export const runtimeNamespaceId = (name: string) => `${name.toLowerCase()}-namespace`;

/**
 * The production PoolWorker shape: an alchemy, migrations-based version whose read-back has no
 * `exports` key. The runtime classes exist as plain SQLite classes the deploy created; only
 * PoolContainer is container-backed.
 */
export const namespaceBaseline = (classes: readonly string[] = runtimeClasses) =>
  decodeNamespaceBaseline({
    accountId: "1".repeat(32),
    scriptName: "synthetic-worker",
    version: {
      id: "baseline-version",
      createdOn: "2026-11-09T00:00:00Z",
      number: 1,
      urls: [],
      mainModule: "worker/index.mjs",
      modules: [
        {
          name: "worker/index.mjs",
          contentType: "application/javascript+module",
          contentBase64: Buffer.from(
            "export class PoolContainer {}\nexport default {};\n",
          ).toString("base64"),
        },
      ],
      containers: [{ className: "PoolContainer" }],
      bindings: [
        {
          name: "PoolContainer",
          type: "durable_object_namespace",
          namespaceId: "legacy-namespace",
          className: "PoolContainer",
        },
        ...classes.map((name) => ({
          name,
          type: "durable_object_namespace" as const,
          namespaceId: runtimeNamespaceId(name),
          className: name,
        })),
        { name: "KEEP", type: "plain_text", text: "synthetic-private-setting" },
      ],
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      usageModel: "standard",
    },
    containers: [{ className: "PoolContainer" }],
    namespaces: [
      {
        id: "legacy-namespace",
        className: "PoolContainer",
        binding: "PoolContainer",
        storage: "sqlite",
      },
      ...classes.map((name) => ({
        id: runtimeNamespaceId(name),
        className: name,
        binding: name,
        storage: "sqlite" as const,
      })),
    ].sort((left, right) => left.className.localeCompare(right.className)),
  });

export function provisioningFixture(name: RuntimeResourceName = "PoolRuntime") {
  const baseline = namespaceBaseline();
  const declaration = runtimeDeclaration(name);
  const request = runtimeNamespaceAttachment(baseline, declaration);
  const manifest = decodeProvisioningManifest({
    schemaVersion: 3,
    disposition: "provision-only",
    candidate: "e".repeat(40),
    stack: "synthetic",
    stage: "production",
    operationId: "synthetic-operation",
    declaration,
    namespaceBaselineDigest: digest(canonical(baseline)),
    namespaceRequestDigest: digest(canonical(request)),
    applicationTemplateDigest: "f".repeat(64),
    active: {
      applicationId: "legacy-app",
      namespaceId: "legacy-namespace",
      version: 31,
      configurationDigest: "0".repeat(64),
      bootId: "legacy-boot",
      selectionEpoch: 0,
    },
  });
  const namespaceId = request.namespaceId;
  const complete = {
    ...manifest,
    applicationTemplateDigest: applicationTemplateDigest(
      expectedApplicationRequest(manifest, namespaceId),
      namespaceId,
    ),
  };
  const enable = {
    coordinatorGo: "synthetic-test-only",
    writerLease: "synthetic-exclusive-writer",
    manifest: provisioningManifestDigest(complete),
    expiresAt: 1000,
  };
  return { baseline, request, manifest: complete, enable, namespaceId };
}
