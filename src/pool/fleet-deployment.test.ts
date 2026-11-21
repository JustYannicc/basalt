import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { layerNonInteractive } from "alchemy/Interaction";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Stack, evalStack } from "alchemy/Stack";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, Layer } from "effect";
import { decodeRuntimeCreate } from "../../scripts/pool-fleet/runtime-create-schema.ts";
import { runtimeDeclaration } from "../../scripts/pool-fleet/test/runtime-declaration.ts";
import { bindPoolObservation, bindRehearsalObservationToken } from "./fleet-observation.ts";
import {
  decodeFleetDeploymentImages,
  fleetBindings,
  fleetClasses,
  fleetInfrastructure,
  poolImageContext,
} from "./fleet-deployment.ts";

const accountId = "1".repeat(32);
const withStackRuntime = <A, E>(
  effect: Effect.Effect<A, E, Effect.Services<ReturnType<typeof evalStack>>>,
) =>
  effect.pipe(
    provideFreshArtifactStore,
    Effect.provide(layerNonInteractive()),
    Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.provideService(State, Effect.die(new Error("missing compiled state"))),
  );
const images = {
  blue: `registry.cloudflare.com/${accountId}/pool@sha256:${"a".repeat(64)}`,
  green: `registry.cloudflare.com/${accountId}/pool@sha256:${"b".repeat(64)}`,
};
async function declarations(
  input = "",
  {
    stage = "synthetic",
    env = {},
    bind,
  }: {
    stage?: string;
    env?: Record<string, string>;
    bind?: (worker: Cloudflare.Worker) => Effect.Effect<void, never, never>;
  } = {},
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
      // As src/pool/deployment.ts binds it.
      if (bind) yield* bind(worker);
      else yield* bindPoolObservation(worker, Boolean(fleet));
      return worker;
    }),
  );
  return Effect.runPromise(
    evalStack(stack, Effect.succeed, { stage }).pipe(
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { POOL_FLEET_IMAGES: input, ...env } })),
      ),
      withStackRuntime,
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

test("production binds the observation secret even without a fleet, and declares no token", async () => {
  const stack = await declarations("", { stage: "production" });
  assert.deepEqual(Object.keys(stack.resources).sort(), ["PoolObservationSecrets", "PoolWorker"]);
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
  // No account token is declared: production's State never held one, and the bootstrap owns it.
  assert.equal(stack.resources.PoolProviderObservationToken, undefined);
  assert.ok(
    !Object.values(stack.resources).some((resource) =>
      resource.Type.startsWith("Cloudflare.ApiToken."),
    ),
  );
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
  assert.equal(stack.resources.PoolProviderObservationToken, undefined);
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

async function poolWorkerClasses(input = "", env: Record<string, string> = {}) {
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
      withStackRuntime,
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
    poolWorkerClasses(JSON.stringify(images), { POOL_FLEET_BUILD: "true" }),
    /fleet-build-with-images/,
  );
});

test("POOL_FLEET_CLASSES=absent leaves both fleet classes out of PoolWorker and refuses any fleet", async () => {
  const absent = await poolWorkerClasses("", { POOL_FLEET_CLASSES: "absent" });
  assert.deepEqual(absent.resources, ["PoolWorker"]);
  assert.equal("PoolRuntimeBlue" in absent.env, false);
  assert.equal("PoolRuntimeGreen" in absent.env, false);
  const declared = await poolWorkerClasses("", { POOL_FLEET_CLASSES: "declared" });
  assert.ok("PoolRuntimeBlue" in declared.env && "PoolRuntimeGreen" in declared.env);
  for (const [input, env] of [
    [JSON.stringify(images), {}],
    ["", { POOL_FLEET_BUILD: "true" }],
  ] as const)
    await assert.rejects(
      poolWorkerClasses(input, { POOL_FLEET_CLASSES: "absent", ...env }),
      /fleet-classes-absent-with-fleet/,
    );
  await assert.rejects(poolWorkerClasses("", { POOL_FLEET_CLASSES: "none" }), /POOL_FLEET_CLASSES/);
});

test("a standing rehearsal stage binds its operator-minted token as a plain secret, never through the Secrets Store", async () => {
  for (const input of ["", JSON.stringify(images)]) {
    const stack = await declarations(input, {
      stage: "test-rehearsal-2",
      env: { POOL_REHEARSAL_OBSERVATION_TOKEN: "operator-minted" },
    });
    // The deploy credential cannot mint tokens: no token resource and no Secrets Store are declared.
    assert.ok(!("PoolObservationSecrets" in stack.resources));
    assert.ok(!("PoolProviderObservationToken" in stack.resources));
    const binding = stack.bindings.PoolWorker?.find(
      (candidate) => candidate.sid === "pool-provider-observation",
    );
    const data = binding?.data as { env?: Record<string, unknown>; bindings?: unknown } | undefined;
    assert.deepEqual(Object.keys(data?.env ?? {}), ["POOL_PROVIDER_OBSERVATION_TOKEN"]);
    assert.equal(data?.bindings, undefined);
  }
});

test("a rehearsal stage without its token binds nothing only when it says absent, and refuses otherwise", async () => {
  const absent = await declarations("", {
    stage: "test-rehearsal-2",
    env: { POOL_REHEARSAL_OBSERVATION: "absent" },
  });
  assert.ok(!("PoolProviderObservationToken" in absent.resources));
  assert.equal(await observationBinding(absent), undefined);
  for (const [env, why] of [
    [{}, /needs its observation token/u],
    [{ POOL_REHEARSAL_OBSERVATION_TOKEN: "  " }, /needs its observation token/u],
    [{ POOL_REHEARSAL_OBSERVATION: "bound" }, /may only be absent/u],
    [
      { POOL_REHEARSAL_OBSERVATION_TOKEN: "operator-minted", POOL_REHEARSAL_OBSERVATION: "absent" },
      /also declares it absent/u,
    ],
  ] as const)
    await assert.rejects(declarations("", { stage: "test-rehearsal-2", env }), why);
});

test("the plain-secret path is exactly test-rehearsal-1 to -9", async () => {
  for (const stage of [
    "test-rehearsal-10",
    "test-rehearsal-0",
    "test-pr-3",
    "rehearsal-2",
    "synthetic",
  ]) {
    const stack = await declarations("", { stage });
    assert.ok(!("PoolProviderObservationToken" in stack.resources), stage);
    assert.equal(await observationBinding(stack), undefined, stage);
  }
});

test("the plain-secret binder refuses any stage that is not test-rehearsal-1 to -9", async () => {
  for (const stage of ["production", "test-rehearsal-10", "test-pr-3", "synthetic"]) {
    await assert.rejects(
      declarations("", { stage, bind: bindRehearsalObservationToken as never }),
      /Only a test-rehearsal-<1-9> stage/u,
      stage,
    );
  }
});
