import { canonical, digest } from "../manifest.ts";
import { runtimeNamespaceRequest } from "../provisioning-namespace.ts";
import {
  decodeProvisioningManifest,
  provisioningManifestDigest,
} from "../provisioning-contract.ts";
import { applicationTemplateDigest, expectedApplicationRequest } from "../provisioning-wire.ts";
import { decodeRuntimeCreate } from "../runtime-create-schema.ts";
import { decodeNamespaceBaseline } from "../provisioning-namespace.ts";
export const runtimeDeclaration = () =>
  decodeRuntimeCreate({
    action: "create-container",
    type: "Cloudflare.Container",
    fqn: "PoolRuntime",
    disposition: "provision-only",
    baseline: "absent",
    accountId: "1".repeat(32),
    instanceId: "2".repeat(32),
    namespace: { workerFqn: "PoolWorker", className: "PoolRuntime", binding: "PoolRuntime" },
    props: {
      name: "synthetic-runtime",
      className: "PoolRuntime",
      image: `registry.cloudflare.com/${"1".repeat(32)}/synthetic@sha256:${"a".repeat(64)}`,
      instanceType: "basic",
      instances: 0,
      maxInstances: 1,
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
export const namespaceBaseline = () =>
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
        {
          name: "helper.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("keep exact bytes").toString("base64"),
        },
      ],
      containers: [{ className: "PoolContainer" }],
      exports: {
        default: { type: "worker", cache: { enabled: true } },
        PoolContainer: {
          type: "durable-object",
          storage: "sqlite",
          container: "PoolContainer",
          state: "created",
        },
      },
      bindings: [
        {
          name: "PoolContainer",
          type: "durable_object_namespace",
          namespaceId: "legacy-namespace",
          className: "PoolContainer",
        },
        { name: "KEEP", type: "plain_text", text: "synthetic-private-setting" },
      ],
      cacheOptions: { enabled: true },
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      usageModel: "standard",
      limits: { cpuMs: 30_000 },
      placement: { mode: "smart" },
    },
    containers: [{ className: "PoolContainer" }],
    namespaces: [
      {
        id: "legacy-namespace",
        className: "PoolContainer",
        binding: "PoolContainer",
        storage: "sqlite",
      },
    ],
  });

export function provisioningFixture() {
  const baseline = namespaceBaseline();
  const declaration = runtimeDeclaration();
  const request = runtimeNamespaceRequest(baseline, declaration, "synthetic-operation");
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
  const namespaceId = "new-namespace";
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
