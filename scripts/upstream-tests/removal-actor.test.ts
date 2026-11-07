import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
const root = new URL("../../.upstream/", import.meta.url);
const { invokeAcquisitionDriver } = await import(
  new URL("packages/sdk/src/implementation/account-acquisition-runtime.ts", root).href
);
const { CurrentActor } = await import(new URL("packages/sdk/src/contracts/executor.ts", root).href);

test("acquisition retirement carries only the host authenticated actor, never the owner or supplied input", async () => {
  const call = () =>
    invokeAcquisitionDriver(
      { fetch },
      {
        owner: "organization:org",
        provider: "prv_fixture",
        method: "codex",
        operation: "remove",
        actor: "forged-input",
        deadline: Date.now() + 1000,
      },
      (context: { actor?: string }) => Effect.succeed(context.actor),
    );
  assert.equal(await Effect.runPromise(call()), undefined);
  assert.equal(
    await Effect.runPromise(call().pipe(Effect.provideService(CurrentActor, "person"))),
    "person",
  );
});
