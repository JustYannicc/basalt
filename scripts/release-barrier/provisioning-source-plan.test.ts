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
import { runtimeDeclaration } from "./test/provisioning-fixtures.ts";
import { containerPublication } from "./test/container-fixture.ts";
import {
  RuntimeImageReleasePlan,
  type ImageReleasePlan,
} from "../../src/pool/image-release-plan.ts";
import { retainedRuntimeImage } from "../../src/pool/legacy-image.ts";
import { sourceRuntimeCreatePlan, sourceObservationTokenPlan } from "./provisioning-source-plan.ts";
import type { ObservationTokenManifest } from "./observation-token-contract.ts";

const accountId = "1".repeat(32);
async function compiled(retainExisting = false) {
  const native = await Effect.runPromise(InMemoryService());
  if (retainExisting)
    for (const resource of ["PoolRuntime", "PoolRuntimeBlue", "PoolRuntimeGreen"] as const) {
      const props = runtimeDeclaration(resource).props;
      const attr = {
        ...containerPublication().previous,
        accountId,
        applicationId: `native-${resource}`,
        configuration: { image: props.image, instanceType: "basic" },
        maxInstances: props.maxInstances,
        instances: 0,
        hash: { image: "7".repeat(16), digest: props.image.split("@")[1]! },
      };
      await Effect.runPromise(
        native.set({
          stack: "synthetic",
          stage: "production",
          fqn: resource,
          value: {
            resourceType: "Cloudflare.Container",
            logicalId: resource,
            fqn: resource,
            namespace: undefined,
            instanceId: "2".repeat(32),
            providerVersion: 0,
            status: "created",
            props,
            attr,
            bindings: [],
            downstream: ["PoolWorker"],
          },
        }),
      );
    }
  let releasePlan: ImageReleasePlan | undefined;
  if (retainExisting) {
    const row = await Effect.runPromise(
      native.get({ stack: "synthetic", stage: "production", fqn: "PoolRuntime" }),
    );
    assert.ok(row && "props" in row);
    assert.ok(row.props);
    const images: ImageReleasePlan["images"] = {};
    for (const color of ["blue", "green"] as const) {
      const resource = color === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen";
      images[color] = retainedRuntimeImage(
        await Effect.runPromise(
          native.get({ stack: "synthetic", stage: "production", fqn: resource }),
        ),
        resource,
      )!.image;
    }
    releasePlan = {
      images,
      legacy: { props: row.props, image: retainedRuntimeImage(row, "PoolRuntime")!.image },
    };
  }
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
      state: Layer.succeed(State, Effect.succeed(native)),
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
      Effect.provideService(RuntimeImageReleasePlan, releasePlan),
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: retainExisting
              ? {}
              : {
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

test("the explicit ordinary release plan retains native single-runtime and fleet image pins without an opt-in image setting", async () => {
  const stack = await compiled(true);
  for (const resource of ["PoolRuntime", "PoolRuntimeBlue", "PoolRuntimeGreen"] as const) {
    const declared = stack.resources[resource];
    assert.ok(declared);
    assert.equal(declared.RemovalPolicy, "retain");
    assert.equal(declared.Props.className, resource);
    assert.equal(declared.Props.image, runtimeDeclaration(resource).props.image);
    assert.equal(declared.Props.maxInstances, resource === "PoolRuntime" ? 1 : 4);
    assert.equal(declared.Props.instances, 0);
  }
  assert.equal("context" in stack.resources.PoolRuntime!.Props, false);
});

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
