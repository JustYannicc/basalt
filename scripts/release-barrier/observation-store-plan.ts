import * as Plan from "alchemy/Plan";
import type { CompiledStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { canonical, digest } from "./manifest.ts";
import {
  ObservationStoreIdentity,
  ObservationStoreManifest,
  ObservationStorePlanRequest,
  observationStoreFqn as fqn,
  observationStoreType as type,
  observationStoreSdkDigest,
  observationStoreAbsentDigest,
} from "./observation-store-contract.ts";
import { observationStoreClient } from "./observation-store-wire.ts";
import { observationStoreState } from "./observation-store-state.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";
import type { ProvisioningWriter } from "./provisioning-operation.ts";

export function observationStoreDeclaration(stack: CompiledStack) {
  sameProvisioningValue(
    "observationStore.scope",
    { name: "basalt", stage: "production" },
    { name: stack.name, stage: stack.stage },
  );
  sameProvisioningValue("observationStore.resources", [fqn], Object.keys(stack.resources));
  sameProvisioningValue("observationStore.actions", [], Object.keys(stack.actions ?? {}));
  sameProvisioningValue("observationStore.bindings", [], Object.values(stack.bindings).flat());
  sameProvisioningValue("observationStore.output", undefined, stack.output);
  const resource = stack.resources[fqn]!;
  const declaration = {
    fqn: resource.FQN,
    id: resource.LogicalId,
    type: resource.Type,
    props: resource.Props ?? {},
    removalPolicy: resource.RemovalPolicy,
    former: resource.FormerFqns ?? [],
  };
  sameProvisioningValue(
    "observationStore.declaration",
    { fqn, id: fqn, type, props: {}, removalPolicy: "retain", former: [] },
    declaration,
  );
  return digest(canonical(declaration));
}

export function assertStorePlan(plan: Plan.Plan, action: "adopted" | "noop") {
  sameProvisioningValue("observationStore.plan.resources", [fqn], Object.keys(plan.resources));
  if (
    plan.destroy ||
    plan.selectedFqns ||
    plan.cycleMembers.size ||
    [plan.actions, plan.deletions, plan.actionDeletions].some(
      (entries) => Object.keys(entries).length,
    )
  )
    throw provisioningRefusal(
      "observation-store-plan-unsupported",
      "observationStore.plan",
      "single-unfiltered-node",
      "changed",
    );
  const node = plan.resources[fqn]!;
  if (action === "adopted" && node.action === "create")
    throw provisioningRefusal(
      "observation-store-missing",
      "observationStore.plan",
      "existing-account-store",
      "absent",
    );
  sameProvisioningValue("observationStore.plan.action", action, node.action);
  sameProvisioningValue("observationStore.plan.props", {}, node.resource.Props);
  if (node.action === "adopted")
    sameProvisioningValue("observationStore.plan.adoptionProps", {}, node.props);
  sameProvisioningValue("observationStore.plan.bindings", [], node.bindings);
  if (
    node.renamedFrom?.length ||
    (action === "adopted" &&
      (node.action !== "adopted" || node.state?.status !== "created" || !node.adopting))
  )
    throw provisioningRefusal(
      "observation-store-plan-unsupported",
      "observationStore.plan.lifecycle",
      "cold-adoption",
      node.state?.status ?? "absent",
    );
  return Schema.decodeUnknownSync(ObservationStoreIdentity, { onExcessProperty: "error" })(
    node.state?.attr,
  );
}

/** Plan sees only this native row, so unrelated saved fleet rows cannot become deletions. */
export const readObservationStorePlan = (stack: CompiledStack, accountId: string) =>
  Effect.gen(function* () {
    observationStoreDeclaration(stack);
    const state = yield* yield* State;
    const client = yield* HttpClient.HttpClient;
    return yield* Plan.make(stack).pipe(
      Retry.none,
      Effect.provideService(State, Effect.succeed(observationStoreState(state, false))),
      Effect.provideService(HttpClient.HttpClient, observationStoreClient(client, accountId)),
      Effect.timeout("30 seconds"),
    );
  });

export function assertObservationStorePlanGo(
  request: typeof ObservationStorePlanRequest.Type,
  now: number,
) {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt <= now
  )
    throw provisioningRefusal(
      "observation-store-plan-not-enabled",
      "observationStore.plan.go",
      "unexpired-writer-GO",
      "unavailable",
    );
}

export const planObservationStore = (
  stack: CompiledStack,
  request: typeof ObservationStorePlanRequest.Type,
  writer: ProvisioningWriter,
  now: () => number = Date.now,
) =>
  Effect.gen(function* () {
    assertObservationStorePlanGo(request, now());
    if (!writer.lease)
      throw provisioningRefusal(
        "observation-store-plan-not-enabled",
        "observationStore.plan.go",
        "unexpired-writer-GO",
        "unavailable",
      );
    const declarationDigest = observationStoreDeclaration(stack);
    const state = yield* yield* State;
    const target = { stack: stack.name, stage: stack.stage, fqn };
    sameProvisioningValue("observationStore.native.before", undefined, yield* state.get(target));
    const plan = yield* readObservationStorePlan(stack, writer.accountId);
    const identity = assertStorePlan(plan, "adopted");
    sameProvisioningValue("observationStore.account", writer.accountId, identity.accountId);
    sameProvisioningValue("observationStore.native.afterPlan", undefined, yield* state.get(target));
    return Schema.decodeUnknownSync(ObservationStoreManifest)({
      format: "pool-observation-store-adoption-v1",
      candidate: writer.candidate,
      stack: "basalt",
      stage: "production",
      operationId: request.operationId,
      ...identity,
      absentRowDigest: observationStoreAbsentDigest,
      sdkSourceDigest: observationStoreSdkDigest(),
      declarationDigest,
    });
  });
