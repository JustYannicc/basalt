import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Stack, evalStack } from "alchemy/Stack";
import { ConfigProvider, Effect, Layer } from "effect";
import { decodeRuntimeCreate } from "../../scripts/release-barrier/runtime-create-schema.ts";
import { runtimeDeclaration } from "../../scripts/release-barrier/test/provisioning-fixtures.ts";
import { withReleaseRuntime } from "../../scripts/release-barrier/runtime.ts";
import { bindPoolObservationSecret } from "./fleet-observation.ts";
import { decodeFleetDeploymentImages, fleetInfrastructure } from "./fleet-deployment.ts";

const accountId = "1".repeat(32);
const images = {
  blue: `registry.cloudflare.com/${accountId}/pool@sha256:${"a".repeat(64)}`,
  green: `registry.cloudflare.com/${accountId}/pool@sha256:${"b".repeat(64)}`,
};
async function declarations(input = "") {
  const stack = Stack(
    "basalt",
    {
      providers: Layer.empty,
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      const env = yield* fleetInfrastructure;
      const worker = yield* Cloudflare.Worker("PoolWorker", {
        main: import.meta.filename,
        env: { ...env },
      });
      if (env) yield* bindPoolObservationSecret(worker);
      return worker;
    }),
  );
  return Effect.runPromise(
    evalStack(stack, Effect.succeed, { stage: "synthetic" }).pipe(
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { POOL_FLEET_IMAGES: input } })),
      ),
      withReleaseRuntime,
    ),
  );
}

test("ordinary deployments without fleet pins declare no fleet applications or observation credential", async () => {
  const stack = await declarations();
  assert.deepEqual(Object.keys(stack.resources), ["PoolWorker"]);
  assert.deepEqual(stack.resources.PoolWorker!.Props.env, {});
});

test("fleet declarations keep independent immutable images, exact namespaces, zero instances and a named Secrets Store binding", async () => {
  const stack = await declarations(JSON.stringify(images));
  for (const [resource, image] of [
    ["PoolRuntimeBlue", images.blue],
    ["PoolRuntimeGreen", images.green],
  ]) {
    const node = stack.resources[resource!]!;
    assert.equal(node.Type, "Cloudflare.Container");
    assert.equal(node.RemovalPolicy, "retain");
    const declaration = runtimeDeclaration(
      resource === "PoolRuntimeBlue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen",
    );
    assert.doesNotThrow(() => decodeRuntimeCreate({ ...declaration, props: node.Props }));
    assert.deepEqual(node.Props, {
      name: `basalt-synthetic-pool-runtime-${resource === "PoolRuntimeBlue" ? "blue" : "green"}`,
      className: resource,
      isExternal: true,
      image,
      instanceType: "basic",
      instances: 0,
      maxInstances: 4,
      schedulingPolicy: "default",
      constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
      observability: { logs: { enabled: true } },
    });
  }
  assert.equal(stack.resources.PoolProviderObservationToken, undefined);
  const store = stack.resources.PoolObservationSecrets!;
  assert.equal(store.Type, "Cloudflare.SecretsStore");
  assert.equal(store.RemovalPolicy, "retain");
  const env = stack.resources.PoolWorker!.Props.env;
  assert.ok(env && typeof env === "object");
  assert.equal("CLOUDFLARE_API_TOKEN" in env, false);
  assert.equal("POOL_PROVIDER_OBSERVATION_TOKEN" in env, false);
  const observation = stack.bindings.PoolWorker!.find(
    (binding) => binding.sid === "pool-provider-observation",
  );
  assert.ok(observation);
  const resolved = await Effect.runPromise(
    Output.evaluate(observation.data, {
      PoolObservationSecrets: { storeId: "2".repeat(32) },
    }).pipe(Effect.provideService(State, Effect.die("Unexpected external reference"))),
  );
  assert.deepEqual(resolved, {
    bindings: [
      {
        type: "secrets_store_secret",
        name: "POOL_PROVIDER_OBSERVATION_TOKEN",
        storeId: "2".repeat(32),
        secretName: "basalt-synthetic-pool-provider-observation",
      },
    ],
  });
  for (const [binding, resource] of [
    ["POOL_BLUE_IMAGE_HASH", "PoolRuntimeBlue"],
    ["POOL_GREEN_IMAGE_HASH", "PoolRuntimeGreen"],
  ]) {
    const input = resource === "PoolRuntimeBlue" ? "a".repeat(16) : "b".repeat(16);
    assert.equal(
      await Effect.runPromise(
        Output.evaluate(env[binding!], {
          [resource!]: { hash: { image: input } },
        }).pipe(Effect.provideService(State, Effect.die("Unexpected external reference"))),
      ),
      input,
    );
  }

  assert.deepEqual(
    Object.keys(env).sort(),
    [
      "PoolRuntimeBlue",
      "PoolRuntimeGreen",
      "POOL_RUNTIME_APPLICATION_ID",
      "POOL_BLUE_APPLICATION_ID",
      "POOL_BLUE_IMAGE_HASH",
      "POOL_GREEN_APPLICATION_ID",
      "POOL_GREEN_IMAGE_HASH",
    ].sort(),
  );
});

test("fleet pins refuse mutable references, other accounts, missing colors and excess configuration", () => {
  for (const invalid of [
    { ...images, blue: `registry.cloudflare.com/${accountId}/pool:latest` },
    { ...images, green: images.green.replace(accountId, "2".repeat(32)) },
    { blue: images.blue },
    { ...images, maximum: 5 },
  ])
    assert.throws(
      () => decodeFleetDeploymentImages(JSON.stringify(invalid), accountId),
      /immutable references/,
    );
});
