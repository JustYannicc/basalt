import { runtimeProofFixture } from "./runtime-proof-fixture.ts";
import { freezeRuntimeHandoff } from "../runtime-slot-manifest.ts";
import {
  decodeHandoffWorker,
  freezeFirstHandoff,
  firstHandoffDigest,
} from "../first-handoff-contract.ts";
import { namespaceBaseline } from "./provisioning-fixtures.ts";

export async function firstHandoffFixture() {
  const f = await runtimeProofFixture();
  const identity = f.manifest.selection.active!;
  const { bootId, ...legacyTarget } = identity;
  const selection = { ...f.manifest.selection, expectedEpoch: 0, active: null };
  const legacy = await freezeRuntimeHandoff({
    ...f.manifest,
    disposition: "preserve-unattested",
    operationId: "legacy-adoption-operation",
    target: { ...legacyTarget, imageInput: "1".repeat(16) },
    provider: { ...f.manifest.provider, namespaceId: "legacy-namespace" },
    selection,
    configuration: {
      ...f.manifest.configuration,
      imageInput: "1".repeat(16),
      managementKey: "legacy-management",
    },
  });
  const candidate = await freezeRuntimeHandoff({
    ...f.manifest,
    selection: { ...selection, expectedEpoch: 1, active: { ...legacy.target, bootId } },
  });
  // The legacy first handoff models a Worker on declarative exports; the shared fixture is the
  // migrations-based PoolWorker, so add the exports this path reads.
  const baseline = namespaceBaseline([]);
  const manifest = freezeFirstHandoff({
    schemaVersion: 3,
    disposition: "first-handoff",
    baseline: decodeHandoffWorker({
      accountId: legacy.controller.accountId,
      scriptName: legacy.controller.scriptName,
      deploymentId: "baseline-deployment",
      version: {
        ...baseline.version,
        exports: {
          default: { type: "worker", cache: { enabled: true } },
          PoolContainer: {
            type: "durable-object",
            storage: "sqlite",
            container: "PoolContainer",
            state: "created",
          },
          PoolRuntime: {
            type: "durable-object",
            storage: "sqlite",
            container: "PoolRuntime",
            state: "created",
          },
        },
        containers: [...baseline.containers, { className: "PoolRuntime" }],
        bindings: [
          ...baseline.version.bindings!,
          { type: "plain_text", name: "POOL_IMAGE_HASH", text: legacy.target.imageInput },
          {
            type: "plain_text",
            name: "POOL_CONTAINER_APPLICATION_ID",
            text: legacy.target.applicationId,
          },
          {
            type: "durable_object_namespace",
            name: "PoolRuntime",
            className: "PoolRuntime",
            namespaceId: "candidate-namespace",
          },
          {
            type: "plain_text",
            name: "POOL_MANAGEMENT_KEY",
            text: legacy.configuration.managementKey,
          },
        ],
      },
    }),
    mainModule: "handoff.mjs",
    modules: [
      {
        name: "handoff.mjs",
        contentType: "application/javascript+module",
        contentBase64: Buffer.from(
          "export class PoolContainer {}\nexport class PoolRuntime {}\nexport default {};\n",
        ).toString("base64"),
      },
    ],
    legacy,
    legacyBootId: identity.bootId,
    candidate,
    promotionOperationId: "candidate-promotion-operation",
    drainOperationId: "legacy-drain-operation",
  });
  return { ...f, manifest, enable: { ...f.enable, manifest: firstHandoffDigest(manifest) } };
}
