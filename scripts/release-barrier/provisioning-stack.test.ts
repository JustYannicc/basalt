import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cloudflare from "alchemy/Cloudflare";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Stack, evalStack } from "alchemy/Stack";
import { ConfigProvider, Effect, Layer } from "effect";
import { provisioningDeclarations } from "./provisioning-stack.ts";
import { RuntimeImageReleasePlan } from "../../src/pool/image-release-plan.ts";
import { withReleaseRuntime } from "./runtime.ts";

const accountId = "1".repeat(32);

test("the bootstrap's PoolWorker declaration keeps both fleet classes, as the deployed stack does", async () => {
  const stack = Stack(
    "basalt",
    {
      providers: Layer.empty,
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    provisioningDeclarations,
  );
  const compiled = await Effect.runPromise(
    evalStack(stack, Effect.succeed, { stage: "production" }).pipe(
      Effect.provideService(Cloudflare.CloudflareEnvironment, Effect.succeed({ accountId })),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      // A first bootstrap: only blue has an image yet.
      Effect.provideService(RuntimeImageReleasePlan, {
        images: {
          blue: `registry.cloudflare.com/${accountId}/pool@sha256:${"a".repeat(64)}`,
        },
      }),
      withReleaseRuntime,
    ),
  );
  const env = compiled.resources.PoolWorker!.Props.env as Record<string, unknown>;
  assert.ok(Object.hasOwn(env, "PoolRuntimeBlue"));
  assert.equal((env.PoolRuntimeGreen as { className?: string }).className, "PoolRuntimeGreen");
});
