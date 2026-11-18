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
import { bindPoolObservation, poolObservationTokenProps } from "./fleet-observation.ts";
import {
  decodeFleetDeploymentImages,
  fleetBindings,
  fleetClasses,
  fleetInfrastructure,
  plannedContainerClasses,
  poolImageContext,
} from "./fleet-deployment.ts";
import { RuntimeImageReleasePlan, type ImageReleasePlan } from "./image-release-plan.ts";

const accountId = "1".repeat(32);
const images = {
  blue: `registry.cloudflare.com/${accountId}/pool@sha256:${"a".repeat(64)}`,
  green: `registry.cloudflare.com/${accountId}/pool@sha256:${"b".repeat(64)}`,
};
async function declarations(
  input = "",
  { stage = "synthetic", env = {} }: { stage?: string; env?: Record<string, string> } = {},
) {
  const stack = Stack(
    "basalt",
    {
      providers: Layer.empty,
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      const fleet = yield* fleetInfrastructure;
      const worker = yield* Cloudflare.Worker("PoolWorker", {
        main: import.meta.filename,
        env: { ...fleet },
      });
      // As src/pool/deployment.ts binds it, with no release plan here.
      yield* bindPoolObservation(worker, Boolean(fleet));
      return worker;
    }),
  );
  return Effect.runPromise(
    evalStack(stack, Effect.succeed, { stage }).pipe(
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { POOL_FLEET_IMAGES: input, ...env } })),
      ),
      withReleaseRuntime,
    ),
  );
}

const observationBinding = async (stack: Awaited<ReturnType<typeof declarations>>) => {
  const binding = stack.bindings.PoolWorker?.find(
    (candidate) => candidate.sid === "pool-provider-observation",
  );
  if (!binding) return undefined;
  return Effect.runPromise(
    Output.evaluate(binding.data, {
      PoolObservationSecrets: { storeId: "2".repeat(32) },
    }).pipe(Effect.provideService(State, Effect.die("Unexpected external reference"))),
  );
};

test("ordinary non-production deployments without fleet pins declare no fleet applications or observation credential", async () => {
  const stack = await declarations();
  assert.deepEqual(Object.keys(stack.resources), ["PoolWorker"]);
  assert.deepEqual(stack.resources.PoolWorker!.Props.env, {});
  assert.equal(await observationBinding(stack), undefined);
});

test("production binds the observation secret and declares its retained token even without a fleet", async () => {
  const stack = await declarations("", { stage: "production" });
  assert.deepEqual(Object.keys(stack.resources).sort(), [
    "PoolObservationSecrets",
    "PoolProviderObservationToken",
    "PoolWorker",
  ]);
  assert.deepEqual(await observationBinding(stack), {
    bindings: [
      {
        type: "secrets_store_secret",
        name: "POOL_PROVIDER_OBSERVATION_TOKEN",
        storeId: "2".repeat(32),
        secretName: "basalt-production-pool-provider-observation",
      },
    ],
  });
  // Exactly the row provisioning created, so a plain plan adopts it as a noop.
  const token = stack.resources.PoolProviderObservationToken!;
  assert.equal(token.Type, "Cloudflare.ApiToken.AccountApiToken");
  assert.equal(token.FQN, "PoolProviderObservationToken");
  assert.equal(token.LogicalId, "PoolProviderObservationToken");
  assert.equal(token.RemovalPolicy, "retain");
  assert.deepEqual(token.Props, poolObservationTokenProps(accountId, "production"));
  assert.deepEqual(token.Props, {
    accountId,
    name: "basalt-production-pool-provider-observation",
    policies: [
      {
        effect: "allow",
        permissionGroups: [{ id: "cfd39eebc07c4e3ea849e4b3d2644637" }],
        resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
      },
    ],
  });
  // The value stays in the Secrets Store; the Worker never receives the token itself.
  assert.equal(stack.bindings.PoolProviderObservationToken?.length ?? 0, 0);
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
  assert.deepEqual(
    stack.resources.PoolProviderObservationToken!.Props,
    poolObservationTokenProps(accountId, "synthetic"),
  );
  const store = stack.resources.PoolObservationSecrets!;
  assert.equal(store.Type, "Cloudflare.SecretsStore");
  assert.equal(store.RemovalPolicy, "retain");
  const env = stack.resources.PoolWorker!.Props.env;
  assert.ok(env && typeof env === "object");
  assert.equal("CLOUDFLARE_API_TOKEN" in env, false);
  assert.equal("POOL_PROVIDER_OBSERVATION_TOKEN" in env, false);
  assert.deepEqual(await observationBinding(stack), {
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

async function poolWorkerClasses(
  input = "",
  plan?: ImageReleasePlan,
  env: Record<string, string> = {},
) {
  const stack = Stack(
    "basalt",
    {
      providers: Layer.empty,
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      return yield* Cloudflare.Worker("PoolWorker", {
        main: import.meta.filename,
        // As src/pool/deployment.ts declares them.
        env: fleetBindings(yield* fleetInfrastructure, yield* fleetClasses),
      });
    }),
  );
  const compiled = await Effect.runPromise(
    evalStack(stack, Effect.succeed, { stage: "synthetic" }).pipe(
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { POOL_FLEET_IMAGES: input, ...env } })),
      ),
      Effect.provideService(RuntimeImageReleasePlan, plan),
      withReleaseRuntime,
    ),
  );
  return {
    containers: Object.values(compiled.resources)
      .filter((resource) => resource.Type === "Cloudflare.Container")
      .map((resource) => (resource.Props as { className: string }).className)
      .sort(),
    resources: Object.keys(compiled.resources).sort(),
    env: compiled.resources.PoolWorker!.Props.env as Record<string, unknown>,
  };
}

test("PoolWorker always hosts both fleet classes, so alchemy is their one migration writer", async () => {
  const plain = await poolWorkerClasses();
  // No image yet: plain local SQLite classes, no container application.
  assert.deepEqual(plain.resources, ["PoolWorker"]);
  for (const name of ["PoolRuntimeBlue", "PoolRuntimeGreen"]) {
    const binding = plain.env[name] as { className?: string; scriptName?: string };
    assert.equal(binding.className, name);
    assert.equal(binding.scriptName, undefined);
  }
  // A pinned color's Container takes the same env key (the alchemy logical id), so binding it
  // later neither creates nor deletes a class.
  const bound = await poolWorkerClasses(JSON.stringify(images));
  assert.deepEqual(bound.resources, ["PoolRuntimeBlue", "PoolRuntimeGreen", "PoolWorker"]);
  for (const name of ["PoolRuntimeBlue", "PoolRuntimeGreen"])
    assert.notEqual(bound.env[name], plain.env[name], `${name} is now its Container`);
});

test("the release preflight's planned container links are the ones the fleet stack declares", async () => {
  // A retained legacy runtime, declared with exactly the props LegacyProps admits.
  const legacyImage = `registry.cloudflare.com/${accountId}/pool@sha256:${"c".repeat(64)}`;
  const legacy = {
    image: legacyImage,
    props: {
      name: "basalt-synthetic-pool-runtime",
      className: "PoolRuntime",
      image: legacyImage,
      instanceType: "basic",
      instances: 0,
      maxInstances: 1,
      schedulingPolicy: "default",
      constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
      observability: { logs: { enabled: true } },
    },
  };
  for (const plan of [
    { images: {} },
    { images: { blue: images.blue } },
    { images: { green: images.green } },
    { images: { blue: images.blue, green: images.green } },
    { legacy, images: {} },
  ] satisfies ImageReleasePlan[]) {
    const evaluated = await poolWorkerClasses("", plan);
    // PoolWorker's own PoolContainer is declared beside the fleet, in src/pool/deployment.ts.
    assert.deepEqual(
      ["PoolContainer", ...evaluated.containers].sort(),
      plannedContainerClasses(plan),
      JSON.stringify(plan),
    );
  }
});

test("POOL_FLEET_BUILD has Alchemy build both colours from the pool image, retained and idle", async () => {
  const stack = await declarations("", { env: { POOL_FLEET_BUILD: "true" } });
  for (const [resource, color] of [
    ["PoolRuntimeBlue", "blue"],
    ["PoolRuntimeGreen", "green"],
  ] as const) {
    const node = stack.resources[resource]!;
    assert.equal(node.Type, "Cloudflare.Container");
    assert.equal(node.RemovalPolicy, "retain");
    assert.deepEqual(node.Props, {
      name: `basalt-synthetic-pool-runtime-${color}`,
      className: resource,
      isExternal: true,
      context: poolImageContext,
      instanceType: "basic",
      instances: 0,
      maxInstances: 4,
      schedulingPolicy: "default",
      constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
      observability: { logs: { enabled: true } },
    });
  }
  const env = stack.resources.PoolWorker!.Props.env as Record<string, unknown>;
  for (const binding of [
    "PoolRuntimeBlue",
    "PoolRuntimeGreen",
    "POOL_BLUE_APPLICATION_ID",
    "POOL_BLUE_IMAGE_HASH",
    "POOL_GREEN_APPLICATION_ID",
    "POOL_GREEN_IMAGE_HASH",
  ])
    assert.ok(binding in env, binding);
  // A built fleet binds the observation secret on any stage, as a pinned one does.
  assert.ok(await observationBinding(stack));
  // Each colour's image hash is its own build input.
  assert.equal(
    await Effect.runPromise(
      Output.evaluate(env.POOL_GREEN_IMAGE_HASH, {
        PoolRuntimeGreen: { hash: { image: "c".repeat(16) } },
      }).pipe(Effect.provideService(State, Effect.die("Unexpected external reference"))),
    ),
    "c".repeat(16),
  );
});

test("a fleet is either built or pinned to images, never both", async () => {
  await assert.rejects(
    declarations(JSON.stringify(images), { env: { POOL_FLEET_BUILD: "true" } }),
    /fleet-build-with-images/,
  );
  await assert.rejects(
    poolWorkerClasses("", { images: { blue: images.blue } }, { POOL_FLEET_BUILD: "true" }),
    /fleet-build-with-images/,
  );
});

test("POOL_FLEET_CLASSES=absent leaves both fleet classes out of PoolWorker and refuses any fleet", async () => {
  const absent = await poolWorkerClasses("", undefined, { POOL_FLEET_CLASSES: "absent" });
  assert.deepEqual(absent.resources, ["PoolWorker"]);
  assert.equal("PoolRuntimeBlue" in absent.env, false);
  assert.equal("PoolRuntimeGreen" in absent.env, false);
  const declared = await poolWorkerClasses("", undefined, { POOL_FLEET_CLASSES: "declared" });
  assert.ok("PoolRuntimeBlue" in declared.env && "PoolRuntimeGreen" in declared.env);
  for (const [input, plan, env] of [
    [JSON.stringify(images), undefined, {}],
    ["", undefined, { POOL_FLEET_BUILD: "true" }],
    ["", { images: {} }, {}],
  ] as const)
    await assert.rejects(
      poolWorkerClasses(input, plan, { POOL_FLEET_CLASSES: "absent", ...env }),
      /fleet-classes-absent-with-fleet/,
    );
  await assert.rejects(
    poolWorkerClasses("", undefined, { POOL_FLEET_CLASSES: "none" }),
    /POOL_FLEET_CLASSES/,
  );
});

test("POOL_WORKER_VERSION_TRAFFIC uploads PoolWorker as a version at that traffic, within 0-100", async () => {
  const { poolWorkerVersion } = await import("./deployment.ts");
  const version = (env: Record<string, string>) =>
    Effect.runPromise(
      poolWorkerVersion.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
    );
  assert.deepEqual(await version({}), {});
  assert.deepEqual(await version({ POOL_WORKER_VERSION_TRAFFIC: "0" }), {
    version: { traffic: 0 },
  });
  assert.deepEqual(await version({ POOL_WORKER_VERSION_TRAFFIC: "100" }), {
    version: { traffic: 100 },
  });
  for (const value of ["101", "-1"])
    await assert.rejects(
      version({ POOL_WORKER_VERSION_TRAFFIC: value }),
      /worker-version-traffic-out-of-range/,
    );
  await assert.rejects(
    version({ POOL_WORKER_VERSION_TRAFFIC: "1.5" }),
    /POOL_WORKER_VERSION_TRAFFIC/,
  );
});
