import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Provider from "alchemy/Provider";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { ConfigProvider, Effect, Layer } from "effect";
import { withReleaseRuntime } from "./runtime.ts";
import { fleetInfrastructure } from "../../src/pool/fleet-deployment.ts";
import { decodeProvisioningManifest } from "./provisioning-contract.ts";
import { provisioningFixture } from "./test/provisioning-fixtures.ts";
import { sourceRuntimeCreatePlan, sourceObservationTokenPlan } from "./provisioning-source-plan.ts";
import type { ObservationTokenManifest } from "./observation-token-contract.ts";

const accountId = "1".repeat(32);
async function compiled() {
  const stack = Stack(
    "synthetic",
    {
      providers: Layer.mergeAll(
        Provider.succeed(Cloudflare.Containers.ContainerPlatform, {
          reconcile: () => Effect.die("Source-plan test cannot execute the provider"),
          delete: () => Effect.die("Source-plan test cannot delete"),
        }),
        Provider.succeed(Cloudflare.ApiToken.AccountApiToken, {
          reconcile: () => Effect.die("Source-plan test cannot execute the provider"),
          delete: () => Effect.die("Source-plan test cannot delete"),
        }),
      ),
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      const env = yield* fleetInfrastructure;
      return yield* Cloudflare.Worker("PoolWorker", {
        main: import.meta.filename,
        env: { ...env },
      });
    }),
  );
  return Effect.runPromise(
    evalStack(stack, Effect.succeed, { stage: "production" }).pipe(
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              POOL_FLEET_IMAGES: JSON.stringify({
                blue: `registry.cloudflare.com/${accountId}/synthetic@sha256:${"a".repeat(64)}`,
                green: `registry.cloudflare.com/${accountId}/synthetic@sha256:${"b".repeat(64)}`,
              }),
            },
          }),
        ),
      ),
      withReleaseRuntime,
    ),
  );
}

test("exact source declarations produce isolated native create plans with the independently observed namespace", async () => {
  const stack = await compiled();
  for (const name of ["PoolRuntimeBlue", "PoolRuntimeGreen"] as const) {
    const f = provisioningFixture(name);
    const manifest = decodeProvisioningManifest({
      ...f.manifest,
      declaration: {
        ...f.manifest.declaration,
        props: {
          ...f.manifest.declaration.props,
          isExternal: true as const,
          name: `basalt-production-pool-runtime-${name === "PoolRuntimeBlue" ? "blue" : "green"}`,
          image: `registry.cloudflare.com/${accountId}/synthetic@sha256:${(name === "PoolRuntimeBlue" ? "a" : "b").repeat(64)}`,
        },
      },
    });
    const plan = await Effect.runPromise(
      sourceRuntimeCreatePlan(stack, manifest, "observed-private-namespace").pipe(
        Effect.provideContext(stack.services),
      ),
    );
    assert.deepEqual(Object.keys(plan.resources), [name]);
    assert.deepEqual(plan.resources[name]!.props, stack.resources[name]!.Props);
    assert.deepEqual(
      plan.resources[name]!.bindings.map((binding) => binding.data),
      [{ durableObjects: { namespaceId: "observed-private-namespace" } }],
    );
    assert.deepEqual(plan.resources[name]!.downstream, ["PoolWorker"]);
    assert.deepEqual(plan.actions, {});
    assert.deepEqual(plan.deletions, {});
  }
  const token: ObservationTokenManifest = {
    format: "pool-observation-token-provisioning-v1",
    candidate: "a".repeat(40),
    stack: "synthetic",
    stage: "production",
    instanceId: "b".repeat(32),
    accountId,
    sdkSourceDigest: "c".repeat(64),
    audit: { accountId, tokenWriteGranted: true, evidenceDigest: "d".repeat(64) },
  };
  await assert.rejects(
    Effect.runPromise(
      sourceObservationTokenPlan(stack, token).pipe(Effect.provideContext(stack.services)),
    ),
    /provisioning-source-declaration-missing/,
  );
});

test("source drift or another stack cannot become an isolated provisioning plan", async () => {
  const stack = await compiled(),
    f = provisioningFixture("PoolRuntimeBlue");
  await assert.rejects(
    Effect.runPromise(
      sourceRuntimeCreatePlan(stack, f.manifest, "namespace").pipe(
        Effect.provideContext(stack.services),
      ),
    ),
    /input-drift/,
  );
  assert.throws(
    () => sourceRuntimeCreatePlan({ ...stack, stage: "another" }, f.manifest, "namespace"),
    /input-drift/,
  );
});
