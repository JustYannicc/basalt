import { decodeRuntimeCreate, type RuntimeResourceName } from "../runtime-create-schema.ts";

/** A fleet runtime create declaration as the signed fleet client decodes one. */
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
