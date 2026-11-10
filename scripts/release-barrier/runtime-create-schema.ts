import { decodeProvisioningInput } from "./provisioning-refusal.ts";
import { Schema } from "effect";

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const identifier = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const image = Schema.String.check(
  Schema.isPattern(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/u),
);

export const RuntimeCreateDeclaration = Schema.Struct({
  action: Schema.Literal("create-container"),
  type: Schema.Literal("Cloudflare.Container"),
  fqn: Schema.Literal("PoolRuntime"),
  disposition: Schema.Literal("provision-only"),
  baseline: Schema.Literal("absent"),
  accountId: identifier,
  instanceId: identifier,
  namespace: Schema.Struct({
    workerFqn: Schema.Literal("PoolWorker"),
    className: Schema.Literal("PoolRuntime"),
    binding: Schema.Literal("PoolRuntime"),
  }),
  props: Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/u)),
    className: Schema.Literal("PoolRuntime"),
    image,
    instanceType: Schema.Literal("basic"),
    instances: Schema.Literal(0),
    maxInstances: Schema.Literal(1),
    schedulingPolicy: Schema.Literal("default"),
    constraints: Schema.Struct({
      jurisdiction: Schema.Literal("eu"),
      regions: Schema.Tuple([Schema.Literal("EEUR"), Schema.Literal("WEUR")]),
    }),
    observability: Schema.Struct({ logs: Schema.Struct({ enabled: Schema.Literal(true) }) }),
  }),
  publication: Schema.Struct({
    inputHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u)),
    imageConfigDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
    platform: Schema.Literal("linux/amd64"),
    capabilityLabel: Schema.Literal("1"),
  }),
  sdkSourceDigest: hash,
  removalPolicy: Schema.Literal("retain"),
  retention: Schema.Struct({
    data: Schema.Literal(true),
    nativeStateRow: Schema.Literal(true),
    recoveryDescriptor: Schema.Literal(true),
  }),
});
export type RuntimeCreateDeclaration = typeof RuntimeCreateDeclaration.Type;
export const decodeRuntimeCreate = decodeProvisioningInput(
  RuntimeCreateDeclaration,
  "provisioning.declaration",
);
