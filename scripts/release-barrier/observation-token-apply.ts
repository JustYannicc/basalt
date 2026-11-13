import * as Apply from "alchemy/Apply";
import type * as Plan from "alchemy/Plan";
import { State } from "alchemy/State/State";
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { digest } from "./manifest.ts";
import {
  assertObservationTokenEnable,
  observationTokenProps,
  type ObservationTokenManifest,
} from "./observation-token-contract.ts";
import { observationTokenClient } from "./observation-token-wire.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";

import {
  observationTokenNative,
  observationTokenFqn,
  observationTokenType as type,
} from "./observation-token-native.ts";

export function observationTokenPlan(input: Plan.Plan, manifest: ObservationTokenManifest) {
  const node = input.resources[observationTokenFqn];
  if (
    !node ||
    node.action !== "create" ||
    node.renamedFrom?.length ||
    node.bindings.length ||
    input.cycleMembers.size ||
    input.destroy
  )
    throw provisioningRefusal(
      "observation-token-plan-unsupported",
      "observationToken.plan",
      "one-unbound-create",
      node?.action ?? null,
    );
  sameProvisioningValue(
    "observationToken.resource",
    { type, fqn: observationTokenFqn, id: observationTokenFqn, removalPolicy: "retain" },
    {
      type: node.resource.Type,
      fqn: node.resource.FQN,
      id: node.resource.LogicalId,
      removalPolicy: node.resource.RemovalPolicy,
    },
  );
  sameProvisioningValue("observationToken.props", observationTokenProps(manifest), node.props);
  sameProvisioningValue(
    "observationToken.resource.props",
    observationTokenProps(manifest),
    node.resource.Props,
  );
  return {
    ...input,
    resources: {
      [observationTokenFqn]: { ...node, provider: { ...node.provider, precreate: undefined } },
    },
    actions: {},
    deletions: {},
    actionDeletions: {},
  };
}

/** Runs only within the durable journal operation. SDK retry or adoption cannot issue another token create. */
export const applyObservationToken = (
  input: Plan.Plan,
  manifest: ObservationTokenManifest,
  enable: ProvisioningEnable | undefined,
  now: () => number,
) =>
  Effect.gen(function* () {
    assertObservationTokenEnable(manifest, enable, now());
    const require = createRequire(import.meta.url);
    const sdk = new URL(
      "../src/Cloudflare/ApiToken/AccountApiToken.ts",
      pathToFileURL(require.resolve("alchemy")),
    );
    sameProvisioningValue(
      "observationToken.sdk",
      manifest.sdkSourceDigest,
      digest(readFileSync(sdk)),
    );
    const plan = observationTokenPlan(input, manifest);
    const node = plan.resources[observationTokenFqn]!;
    const state = yield* yield* State;
    const target = { stack: manifest.stack, stage: manifest.stage, fqn: observationTokenFqn };
    const prior = yield* state.get(target);
    if (prior)
      throw provisioningRefusal(
        "observation-token-native-state-exists",
        "observationToken.native",
        "absent",
        prior.status,
      );
    const pending = {
      status: "creating" as const,
      fqn: observationTokenFqn,
      logicalId: observationTokenFqn,
      resourceType: type,
      instanceId: manifest.instanceId,
      props: node.props,
      bindings: node.bindings,
      downstream: node.downstream,
      removalPolicy: node.resource.RemovalPolicy,
      providerVersion: node.provider.version ?? 0,
      attr: undefined,
      namespace: node.resource.Namespace,
    };
    yield* state.set({ ...target, value: pending });
    const client = yield* HttpClient.HttpClient;
    yield* Apply.apply({
      ...plan,
      resources: { [observationTokenFqn]: { ...node, state: pending } },
    }).pipe(
      Retry.none,
      Effect.provideService(
        HttpClient.HttpClient,
        observationTokenClient(client, manifest, enable, now),
      ),
    );
    return yield* observationTokenNative(manifest);
  });
