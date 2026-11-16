import * as Apply from "alchemy/Apply";
import type { CompiledStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { canonical, digest } from "./manifest.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { provisioningJournal, type ProvisioningStore } from "./provisioning-journal.ts";
import { assertSupportedPlan } from "./plan-admission.ts";
import {
  ObservationStoreIdentity,
  observationStoreFqn as fqn,
  observationStoreType as type,
  observationStoreAbsentDigest,
  observationStoreDigest,
  observationStoreSdkDigest,
  assertObservationStoreEnable,
  type ObservationStoreManifest,
} from "./observation-store-contract.ts";
import {
  assertStorePlan,
  observationStoreDeclaration,
  readObservationStorePlan,
} from "./observation-store-plan.ts";
import { observationStoreClient } from "./observation-store-wire.ts";
import { observationStoreState } from "./observation-store-state.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";

const Receipt = Schema.Struct({
  format: Schema.Literal("pool-observation-store-adoption-receipt-v1"),
  manifest: Schema.String,
  nativeAfterDigest: Schema.String,
  action: Schema.Literal("noop"),
  barrier: Schema.Literal("PASS"),
  barrierScope: Schema.Literal("PoolObservationSecrets"),
});
const identity = ({ accountId, storeId, storeName }: ObservationStoreManifest) => ({
  accountId,
  storeId,
  storeName,
});

export const verifyObservationStore = (stack: CompiledStack, manifest: ObservationStoreManifest) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
    sameProvisioningValue(
      "observationStore.native.identity",
      identity(manifest),
      Schema.decodeUnknownSync(ObservationStoreIdentity, { onExcessProperty: "error" })(
        row && "attr" in row ? row.attr : undefined,
      ),
    );
    sameProvisioningValue(
      "observationStore.native.shape",
      {
        status: "updated",
        fqn,
        logicalId: fqn,
        resourceType: type,
        props: {},
        bindings: [],
        removalPolicy: "retain",
      },
      row && "props" in row
        ? {
            status: row.status,
            fqn: row.fqn,
            logicalId: row.logicalId,
            resourceType: row.resourceType,
            props: row.props,
            bindings: row.bindings,
            removalPolicy: row.removalPolicy,
          }
        : null,
    );
    const nativeAfterDigest = digest(canonical(encodeState(row!)));
    const next = yield* readObservationStorePlan(stack, manifest.accountId);
    sameProvisioningValue(
      "observationStore.readback",
      identity(manifest),
      assertStorePlan(next, "noop"),
    );
    assertSupportedPlan(next);
    sameProvisioningValue(
      "observationStore.native.afterReplan",
      nativeAfterDigest,
      digest(
        canonical(encodeState((yield* state.get({ stack: stack.name, stage: stack.stage, fqn }))!)),
      ),
    );
    return Schema.decodeUnknownSync(Receipt)({
      format: "pool-observation-store-adoption-receipt-v1",
      manifest: observationStoreDigest(manifest),
      nativeAfterDigest,
      action: "noop",
      barrier: "PASS",
      barrierScope: fqn,
    });
  });

export const applyObservationStore = (
  stack: CompiledStack,
  manifest: ObservationStoreManifest,
  enable: ProvisioningEnable,
  now: () => number,
) =>
  Effect.gen(function* () {
    assertObservationStoreEnable(manifest, enable, now());
    sameProvisioningValue(
      "observationStore.sdk",
      manifest.sdkSourceDigest,
      observationStoreSdkDigest(),
    );
    sameProvisioningValue(
      "observationStore.declaration",
      manifest.declarationDigest,
      observationStoreDeclaration(stack),
    );
    sameProvisioningValue(
      "observationStore.absentRowDigest",
      observationStoreAbsentDigest,
      manifest.absentRowDigest,
    );
    const state = yield* yield* State;
    const target = { stack: stack.name, stage: stack.stage, fqn };
    sameProvisioningValue("observationStore.native.before", undefined, yield* state.get(target));
    const plan = yield* readObservationStorePlan(stack, manifest.accountId);
    sameProvisioningValue(
      "observationStore.frozenIdentity",
      identity(manifest),
      assertStorePlan(plan, "adopted"),
    );
    sameProvisioningValue(
      "observationStore.native.beforeApply",
      undefined,
      yield* state.get(target),
    );
    const node = plan.resources[fqn]!;
    const client = yield* HttpClient.HttpClient;
    assertObservationStoreEnable(manifest, enable, now());
    yield* Apply.apply({
      ...plan,
      resources: {
        [fqn]: {
          ...node,
          provider: {
            ...node.provider,
            reconcile: (input) =>
              node.provider
                .reconcile(input)
                .pipe(
                  Effect.tap((attributes) =>
                    Effect.sync(() =>
                      sameProvisioningValue(
                        "observationStore.reconciledIdentity",
                        identity(manifest),
                        attributes,
                      ),
                    ),
                  ),
                ),
          },
        },
      },
    }).pipe(
      Retry.none,
      Effect.provideService(State, Effect.succeed(observationStoreState(state, true))),
      Effect.provideService(
        HttpClient.HttpClient,
        observationStoreClient(client, manifest.accountId),
      ),
      Effect.timeout("60 seconds"),
    );
    return yield* verifyObservationStore(stack, manifest);
  });

export const provisionObservationStore = (
  stack: CompiledStack,
  input: {
    manifest: ObservationStoreManifest;
    enable: ProvisioningEnable;
    store: ProvisioningStore;
    now: () => number;
  },
) =>
  Effect.gen(function* () {
    assertObservationStoreEnable(input.manifest, input.enable, input.now());
    const journal = provisioningJournal(
      input.store,
      input.manifest.candidate,
      observationStoreDigest(input.manifest),
      fqn,
    );
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof applyObservationStore>>>();
    const run = Effect.runPromiseWith(context);
    const receipt = yield* Effect.promise(() =>
      journal.once(
        "store-adopt",
        observationStoreDigest(input.manifest),
        () => run(applyObservationStore(stack, input.manifest, input.enable, input.now)),
        Schema.decodeUnknownSync(Receipt),
      ),
    );
    const current = yield* verifyObservationStore(stack, input.manifest);
    sameProvisioningValue("observationStore.receipt", receipt, current);
    yield* Effect.promise(() => journal.finish(digest(canonical(receipt))));
    return receipt;
  });
