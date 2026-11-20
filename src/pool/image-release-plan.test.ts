import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, type FileSystem, type Path } from "effect";
import { desiredPoolImageInput, readinessImageInput } from "./image-release-plan.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

test("a pinned root is expected at the pin's input, not at today's context", async () => {
  const context = await run(desiredPoolImageInput);
  assert.match(context, /^[0-9a-f]{16}$/u);
  // The 16 Nov root's build input; today's containers/pool differs from it.
  const pinned = "526fa60bed0df442";
  assert.notEqual(pinned, context);
  assert.equal(await run(readinessImageInput(pinned, false)), pinned);
  // A root built from the context, or an image release with a candidate, expects today's image.
  assert.equal(await run(readinessImageInput(undefined, false)), context);
  assert.equal(await run(readinessImageInput(pinned, true)), context);
});
