import type { CompiledStack } from "alchemy/Stack";
import { Effect } from "effect";
import type { ProvisioningEnable, RuntimeProvisioningManifest } from "./provisioning-contract.ts";
import { assertProvisioningEnable } from "./provisioning-contract.ts";
import { runtimeProvisioningProvider } from "./provisioning-cloudflare.ts";
import { provisionRuntime } from "./runtime-provisioning.ts";
import type { ProvisioningStore } from "./provisioning-journal.ts";
import type { RuntimeProvisioningProvider } from "./runtime-provisioning.ts";
import { sourceObservationTokenPlan, sourceRuntimeCreatePlan } from "./provisioning-source-plan.ts";
import {
  assertObservationTokenEnable,
  type ObservationTokenManifest,
} from "./observation-token-contract.ts";
import { observationTokenProvider } from "./observation-token-cloudflare.ts";
import { provisionObservationToken } from "./observation-token-provision.ts";

/** A reviewed bootstrap provisions one source declaration; it cannot apply the rest of the stack. */
export const provisionDeclaredRuntime = (
  stack: CompiledStack,
  input: {
    manifest: RuntimeProvisioningManifest;
    enable: ProvisioningEnable | undefined;
    scriptName: string;
    store: ProvisioningStore;
    active: RuntimeProvisioningProvider["active"];
    now?: () => number;
  },
) =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now;
    assertProvisioningEnable(input.manifest, input.enable, now());
    yield* sourceRuntimeCreatePlan(stack, input.manifest, "$namespace-receipt");
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof sourceRuntimeCreatePlan>>>();
    const run = Effect.runPromiseWith(context);
    const provider = yield* runtimeProvisioningProvider({
      ...input,
      plan: (namespaceId) => run(sourceRuntimeCreatePlan(stack, input.manifest, namespaceId)),
    });
    return yield* Effect.promise(() =>
      provisionRuntime(input.manifest, input.store, provider, input.enable, now),
    );
  });

export const provisionDeclaredObservationToken = (
  stack: CompiledStack,
  input: {
    manifest: ObservationTokenManifest;
    enable: ProvisioningEnable | undefined;
    store: ProvisioningStore;
    now?: () => number;
  },
) =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now;
    assertObservationTokenEnable(input.manifest, input.enable, now());
    const plan = yield* sourceObservationTokenPlan(stack, input.manifest);
    const provider = yield* observationTokenProvider({
      manifest: input.manifest,
      enable: input.enable,
      plan,
      now,
    });
    return yield* Effect.promise(() =>
      provisionObservationToken(input.manifest, input.enable, input.store, provider, now),
    );
  });
