import * as Apply from "alchemy/Apply";
import type * as Plan from "alchemy/Plan";
import { State } from "alchemy/State/State";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { configurationCodec, attachmentCodec } from "./container-schema.ts";
import {
  assertProvisioningEnable,
  type ProvisioningEnable,
  type RuntimeProvisioningManifest,
} from "./provisioning-contract.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";
import { singleFinalCreateClient } from "./provisioning-wire.ts";

export const CreatedRuntimeApplication = Schema.Struct({
  applicationId: Schema.NonEmptyString,
  applicationName: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
  version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  createdAt: Schema.String,
  instances: Schema.Literal(0),
  maxInstances: Schema.Literal(1),
  schedulingPolicy: Schema.Literal("default"),
  constraints: Schema.Unknown,
  affinities: Schema.optionalKey(Schema.Unknown),
  configuration: configurationCodec,
  durableObjects: attachmentCodec,
  hash: Schema.optionalKey(
    Schema.Struct({ image: Schema.String, digest: Schema.String, configuration: Schema.String }),
  ),
  dev: Schema.optionalKey(Schema.Unknown),
});
export const decodeCreatedRuntime = decodeProvisioningInput(
  CreatedRuntimeApplication,
  "provisioning.application",
);
export type CreatedRuntimeApplication = typeof CreatedRuntimeApplication.Type;

export function runtimeCreatePlan(
  input: Plan.Plan,
  manifest: RuntimeProvisioningManifest,
  namespaceId: string,
) {
  const node = input.resources.PoolRuntime;
  const declaration = manifest.declaration;
  if (
    !node ||
    node.action !== "create" ||
    node.renamedFrom?.length ||
    Object.values(input.resources).some((other) => other !== node && other.action !== "noop") ||
    Object.keys(input.actions).length ||
    Object.keys(input.deletions).length ||
    Object.keys(input.actionDeletions).length ||
    input.cycleMembers.size ||
    input.destroy
  )
    throw provisioningRefusal(
      "provisioning-create-plan-unsupported",
      "plan.action",
      "one-acyclic-PoolRuntime-create",
      node?.action ?? null,
    );
  sameProvisioningValue(
    "plan.resource",
    { type: declaration.type, fqn: declaration.fqn, id: declaration.fqn, removalPolicy: "retain" },
    {
      type: node.resource.Type,
      fqn: node.resource.FQN,
      id: node.resource.LogicalId,
      removalPolicy: node.resource.RemovalPolicy,
    },
  );
  sameProvisioningValue("plan.props", declaration.props, node.props);
  sameProvisioningValue("plan.resource.props", declaration.props, node.resource.Props);
  const bindings = node.bindings.filter((binding) => binding.action !== "delete");
  if (bindings.length !== 1)
    throw provisioningRefusal(
      "provisioning-final-attachment-missing",
      "plan.bindings.count",
      1,
      bindings.length,
    );
  sameProvisioningValue("plan.namespace", { durableObjects: { namespaceId } }, bindings[0]!.data);
  return {
    ...input,
    resources: { PoolRuntime: { ...node, provider: { ...node.provider, precreate: undefined } } },
  };
}

/** Called only inside the journal's one-shot application operation. */
export const applyRuntimeCreate = (
  input: Plan.Plan,
  manifest: RuntimeProvisioningManifest,
  namespaceId: string,
  enable: ProvisioningEnable | undefined,
  now: () => number,
) =>
  Effect.gen(function* () {
    assertProvisioningEnable(manifest, enable, now());
    const require = createRequire(import.meta.url);
    const sdk = new URL(
      "../src/Cloudflare/Containers/ContainerProvider.ts",
      pathToFileURL(require.resolve("alchemy")),
    );
    sameProvisioningValue(
      "sdk.sourceDigest",
      manifest.declaration.sdkSourceDigest,
      createHash("sha256")
        .update(readFileSync(fileURLToPath(sdk)))
        .digest("hex"),
    );
    const plan = runtimeCreatePlan(input, manifest, namespaceId);
    const node = plan.resources.PoolRuntime!;
    const state = yield* yield* State;
    const target = { stack: manifest.stack, stage: manifest.stage, fqn: "PoolRuntime" };
    const prior = yield* state.get(target);
    if (
      prior &&
      (prior.status !== "creating" ||
        prior.attr !== undefined ||
        prior.instanceId !== manifest.declaration.instanceId)
    )
      throw provisioningRefusal(
        "provisioning-native-baseline-drift",
        "native.state",
        "absent-or-same-unresolved-create",
        prior.status,
      );
    const pending = {
      status: "creating" as const,
      fqn: "PoolRuntime",
      logicalId: "PoolRuntime",
      resourceType: "Cloudflare.Container",
      instanceId: manifest.declaration.instanceId,
      props: node.props,
      bindings: node.bindings,
      downstream: node.downstream,
      removalPolicy: node.resource.RemovalPolicy,
      providerVersion: node.provider.version ?? 0,
      attr: undefined,
      namespace: node.resource.Namespace,
    };
    if (prior) {
      for (const key of [
        "fqn",
        "logicalId",
        "resourceType",
        "instanceId",
        "props",
        "bindings",
        "downstream",
        "removalPolicy",
        "providerVersion",
        "namespace",
      ] as const)
        sameProvisioningValue(`native.pending.${key}`, pending[key], prior[key]);
    } else yield* state.set({ ...target, value: pending });
    const client = yield* HttpClient.HttpClient;
    yield* Apply.apply({
      ...plan,
      resources: { PoolRuntime: { ...node, state: prior ?? pending } },
    }).pipe(
      Retry.none,
      Effect.provideService(
        HttpClient.HttpClient,
        singleFinalCreateClient(client, manifest, namespaceId, enable, now),
      ),
    );
    const saved = yield* state.get(target);
    if (saved?.status !== "created")
      throw provisioningRefusal(
        "provisioning-native-result-unconfirmed",
        "native.status",
        "created",
        saved?.status ?? null,
      );
    return decodeCreatedRuntime(saved.attr);
  });
