import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, Layer } from "effect";
import * as Alchemist from "alchemy/Alchemist";
import * as Interaction from "alchemy/Interaction";
import { storeCannotBootstrap } from "./state-store-guard.ts";

test("the release process cannot answer a State store bootstrap prompt", async () => {
  await Effect.runPromise(
    storeCannotBootstrap.pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
});

test("a process that could answer the prompt refuses before planning", async () => {
  const answering = Layer.succeed(Interaction.Interaction, {
    prompt: { confirm: () => Effect.succeed(true) },
  } as never);
  const exit = await Effect.runPromiseExit(storeCannotBootstrap.pipe(Effect.provide(answering)));
  assert.equal(Exit.isFailure(exit), true);
  assert.match(
    String(Exit.isFailure(exit) ? JSON.stringify(exit.cause) : ""),
    /StateStoreBootstrapPossible/u,
  );
});
