import { State } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { Effect } from "effect";
import { canonical, digest } from "./manifest.ts";
import { decodeCreatedRuntime } from "./provisioning-apply.ts";
import type { RuntimeProvisioningManifest } from "./provisioning-contract.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

export const runtimeNativeState = (manifest: RuntimeProvisioningManifest, namespaceId: string) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const row = yield* state.get({
      stack: manifest.stack,
      stage: manifest.stage,
      fqn: "PoolRuntime",
    });
    if (row?.status !== "created")
      throw provisioningRefusal(
        "provisioning-native-result-unconfirmed",
        "native.status",
        "created",
        row?.status ?? null,
      );
    sameProvisioningValue(
      "native.identity",
      {
        fqn: "PoolRuntime",
        logicalId: "PoolRuntime",
        resourceType: "Cloudflare.Container",
        instanceId: manifest.declaration.instanceId,
        removalPolicy: "retain",
        props: manifest.declaration.props,
      },
      {
        fqn: row.fqn,
        logicalId: row.logicalId,
        resourceType: row.resourceType,
        instanceId: row.instanceId,
        removalPolicy: row.removalPolicy,
        props: row.props,
      },
    );
    const live = row.bindings;
    sameProvisioningValue("native.binding.count", 1, live.length);
    sameProvisioningValue(
      "native.binding.namespace",
      { durableObjects: { namespaceId } },
      live[0]?.data,
    );
    const application = decodeCreatedRuntime(row.attr);
    return { application, digest: digest(canonical(encodeState(row))) };
  });
