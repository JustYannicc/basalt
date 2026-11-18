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
import { poolImageContext } from "./fleet-deployment.ts";
import { rootContainer } from "./root-image-pin.ts";

const accountId = "1".repeat(32);
const pin = {
  image: `registry.cloudflare.com/${accountId}/basalt-pool@sha256:${"e".repeat(64)}`,
  input: "0123456789abcdef",
};

async function declare(stage: string, env: Record<string, string> = {}) {
  let root: Effect.Success<typeof rootContainer> | undefined;
  const stack = Stack(
    "basalt",
    {
      providers: Layer.empty,
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      root = yield* rootContainer;
      return root.application;
    }),
  );
  const compiled = await Effect.runPromise(
    evalStack(stack, Effect.succeed, { stage }).pipe(
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      provideFreshArtifactStore,
      Effect.provide(layerNonInteractive()),
      Effect.provide(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.provideService(State, Effect.die(new Error("missing compiled state"))),
    ),
  );
  return { props: compiled.resources.PoolContainer!.Props as Record<string, unknown>, root: root! };
}

const resolve = (value: unknown, hash: { image: string; digest?: string }) =>
  Effect.runPromise(
    Output.evaluate(value, { PoolContainer: { hash } }).pipe(
      Effect.provideService(State, Effect.die("Unexpected external reference")),
    ),
  );

test("production refuses to deploy the legacy root without a digest pin", async () => {
  await assert.rejects(
    declare("production", { POOL_ROOT_IMAGE_REQUIRED: "true" }),
    /root-image-pin-missing/,
  );
  // Until the barrier is deleted, its own pin path (and fixtures) evaluate production unpinned.
  const legacyLayer = await declare("production");
  assert.equal(legacyLayer.props.context, poolImageContext);
  // The switch only guards production; a first stage deploy has no root to roll.
  const stage = await declare("test-cutover", { POOL_ROOT_IMAGE_REQUIRED: "true" });
  assert.equal(stage.props.context, poolImageContext);
});

test("a pinned root is declared by its digest and keeps the build input the controller knows", async () => {
  const { props, root } = await declare("production", { POOL_ROOT_IMAGE: JSON.stringify(pin) });
  assert.equal(props.image, pin.image);
  assert.equal("context" in props, false);
  assert.equal(props.className, "PoolContainer");
  assert.equal(props.maxInstances, 1);
  assert.deepEqual(props.constraints, { jurisdiction: "eu", regions: ["EEUR", "WEUR"] });
  // With an image prop Alchemy's hash.image hashes the reference; the binding must not follow it.
  assert.equal(root.imageHash, pin.input);
  assert.equal(await resolve(root.imageInput, { image: "feedfacefeedface" }), pin.input);
});

test("pins outside the deployment account, mutable references and extra fields are refused", async () => {
  await assert.rejects(
    declare("production", {
      POOL_ROOT_IMAGE: JSON.stringify({
        ...pin,
        image: pin.image.replace(accountId, "2".repeat(32)),
      }),
    }),
    /root-image-pin-other-account/,
  );
  for (const invalid of [
    { ...pin, image: `registry.cloudflare.com/${accountId}/basalt-pool:latest` },
    { ...pin, input: "0123" },
    { ...pin, digest: "sha256:x" },
    { image: pin.image },
  ])
    await assert.rejects(
      declare("production", { POOL_ROOT_IMAGE: JSON.stringify(invalid) }),
      /root-image-pin-malformed/,
      JSON.stringify(invalid),
    );
  await assert.rejects(declare("production", { POOL_ROOT_IMAGE: "{" }), /root-image-pin-malformed/);
});

test("other stages without a pin still build the root from the pool image context", async () => {
  const { props, root } = await declare("pr-1");
  assert.equal(props.context, poolImageContext);
  assert.equal("image" in props, false);
  assert.equal(await resolve(root.imageHash, { image: "feedfacefeedface" }), "feedfacefeedface");
  assert.equal(await resolve(root.imageInput, { image: "feedfacefeedface" }), "feedfacefeedface");
  await assert.rejects(resolve(root.imageHash, { image: "" }), /no build revision/);
  // A pin on another stage is honoured the same way.
  const pinned = await declare("pr-1", { POOL_ROOT_IMAGE: JSON.stringify(pin) });
  assert.equal(pinned.props.image, pin.image);
});
