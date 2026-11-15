import type * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Output from "alchemy/Output";
import type { CompiledStack } from "alchemy/Stack";
import { Effect } from "effect";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";
import type { RuntimeProvisioningManifest } from "./provisioning-contract.ts";
import {
  observationTokenProps,
  type ObservationTokenManifest,
} from "./observation-token-contract.ts";

function dependencies(value: unknown) {
  const found: unknown = Output.resolveUpstream(value);
  return found && typeof found === "object" ? Object.keys(found) : [];
}
const isolatedCreate = (
  stack: CompiledStack,
  target: {
    fqn: string;
    type: string;
    props: unknown;
    worker?: { fqn: string; className: string; namespaceId: string };
  },
) =>
  Effect.gen(function* () {
    const resource = stack.resources[target.fqn];
    if (!resource || resource.FormerFqns?.length)
      throw provisioningRefusal(
        "provisioning-source-declaration-missing",
        "source.resource",
        target.fqn,
        resource?.FQN ?? null,
      );
    sameProvisioningValue(
      "source.resource",
      { fqn: target.fqn, id: target.fqn, type: target.type, removalPolicy: "retain" },
      {
        fqn: resource.FQN,
        id: resource.LogicalId,
        type: resource.Type,
        removalPolicy: resource.RemovalPolicy,
      },
    );
    sameProvisioningValue("source.props", target.props, resource.Props);
    const raw = stack.bindings[target.fqn] ?? [];
    if (raw.length !== (target.worker ? 1 : 0))
      throw provisioningRefusal(
        "provisioning-source-bindings-drift",
        "source.bindings",
        target.worker ? 1 : 0,
        raw.length,
      );
    const bindings: Plan.BindingNode[] = [];
    for (const binding of raw) {
      const worker = target.worker!;
      sameProvisioningValue("source.binding.id", worker.className, binding.sid);
      sameProvisioningValue(
        "source.binding.dependencies",
        [worker.fqn],
        dependencies(binding.data),
      );
      const data: unknown = yield* Output.evaluate(binding.data, {
        [worker.fqn]: {
          durableObjectNamespaces: { [worker.className]: worker.namespaceId },
        },
      });
      sameProvisioningValue(
        "source.binding.namespace",
        { durableObjects: { namespaceId: worker.namespaceId } },
        data,
      );
      bindings.push({ sid: binding.sid, action: "create", data });
    }
    const downstream = Object.entries(stack.resources).flatMap(([fqn, candidate]) =>
      fqn !== target.fqn &&
      (dependencies(candidate.Props).includes(target.fqn) ||
        dependencies(stack.bindings[fqn]).includes(target.fqn))
        ? [fqn]
        : [],
    );
    const provider = yield* Provider.findProviderByType(resource.Type, resource.Mode).pipe(
      Effect.provideContext(stack.services),
    );
    // Namespace creation was independently witnessed. No Worker update or other proposed resource enters this apply.
    return {
      resources: {
        [target.fqn]: {
          action: "create",
          resource,
          provider,
          mode: resource.Mode,
          props: resource.Props,
          downstream,
          bindings,
          state: undefined,
        },
      },
      actions: {},
      deletions: {},
      actionDeletions: {},
      output: undefined,
      cycleMembers: new Set<string>(),
    } satisfies Plan.Plan;
  });

export const sourceRuntimeCreatePlan = (
  stack: CompiledStack,
  manifest: RuntimeProvisioningManifest,
  namespaceId: string,
) => {
  sameProvisioningValue(
    "source.scope",
    { name: manifest.stack, stage: manifest.stage },
    { name: stack.name, stage: stack.stage },
  );
  if (!namespaceId)
    throw provisioningRefusal(
      "provisioning-source-namespace-missing",
      "source.namespace",
      "observed-namespace",
      null,
    );
  return isolatedCreate(stack, {
    fqn: manifest.declaration.fqn,
    type: manifest.declaration.type,
    props: manifest.declaration.props,
    worker: {
      fqn: manifest.declaration.namespace.workerFqn,
      className: manifest.declaration.namespace.className,
      namespaceId,
    },
  });
};
export const sourceObservationTokenPlan = (
  stack: CompiledStack,
  manifest: ObservationTokenManifest,
) => {
  sameProvisioningValue(
    "source.scope",
    { name: manifest.stack, stage: manifest.stage },
    { name: stack.name, stage: stack.stage },
  );
  return isolatedCreate(stack, {
    fqn: "PoolProviderObservationToken",
    type: "Cloudflare.ApiToken.AccountApiToken",
    props: observationTokenProps(manifest),
  });
};
