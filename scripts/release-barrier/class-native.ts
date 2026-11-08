import type * as Plan from "alchemy/Plan";
import { State, isResourceState } from "alchemy/State/State";
import { Effect } from "effect";
import { havePropsChanged } from "alchemy/Diff";
import { declaredMismatch } from "./declared-refusal.ts";
import { classNamespaces, type ClassObservation } from "./declared-class-contract.ts";
import type { ClassRecord } from "./class-history.ts";
import { canonical } from "./manifest.ts";

export const classNative = (
  node: Plan.Apply,
  scope: { stack: string; stage: string },
  saved?: ClassRecord,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const current = yield* state.get({ ...scope, fqn: node.resource.FQN });
    if (
      !isResourceState(current) ||
      (current.status !== "created" && current.status !== "updated") ||
      !node.state ||
      havePropsChanged(node.state, current) ||
      current.resourceType !== "Cloudflare.Worker" ||
      current.fqn !== node.resource.FQN ||
      current.logicalId !== node.resource.LogicalId ||
      current.providerVersion !== (node.provider.version ?? 0) ||
      current.providerMode !== node.mode ||
      typeof current.attr.workerId !== "string" ||
      !current.attr.workerId ||
      (saved &&
        (saved.native.workerId !== current.attr.workerId ||
          saved.native.instanceId !== current.instanceId ||
          saved.native.providerVersion !== current.providerVersion ||
          saved.native.mode !== current.providerMode ||
          (saved.status === "ready" &&
            saved.observed &&
            canonical(current.attr.durableObjectNamespaces) !==
              canonical(classNamespaces(saved.observed)))))
    )
      throw declaredMismatch(
        "declared-class-native-state-drift",
        node.resource.FQN,
        { native: saved?.native ?? node.state },
        { native: current },
        "Cloudflare.Worker",
      );
    return current;
  });

export const commitClassNative = (
  node: Plan.Apply,
  scope: { stack: string; stage: string },
  saved: ClassRecord,
  observed: ClassObservation,
) =>
  Effect.gen(function* () {
    const current = yield* classNative(node, scope, saved);
    if (
      current.attr.accountId !== observed.accountId ||
      current.attr.workerName !== observed.scriptName
    )
      throw declaredMismatch(
        "declared-class-native-target-drift",
        node.resource.FQN,
        { accountId: current.attr.accountId, scriptName: current.attr.workerName },
        observed,
        "Cloudflare.Worker",
      );
    const state = yield* yield* State;
    // Expansion preserves the baseline code. Its old bundle hash/props stay truthful until admitted candidate code activates.
    yield* state.set({
      ...scope,
      fqn: node.resource.FQN,
      value: {
        ...current,
        attr: {
          ...current.attr,
          tags: observed.settings.tags ?? [],
          durableObjectNamespaces: classNamespaces(observed),
        },
      },
    });
  });
