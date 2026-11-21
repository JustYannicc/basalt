import assert from "node:assert/strict";
import { test } from "node:test";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";
import { masterCrashBinding } from "./deployment.ts";

const binding = (stage: string) =>
  Effect.runPromise(masterCrashBinding.pipe(Effect.provideService(Stage, stage)));

test("only a disposable stage binds POOL_ALLOW_MASTER_CRASH, and production never does", async () => {
  for (const stage of ["test-pr-12", "test-native-cutover"])
    assert.deepEqual(await binding(stage), { POOL_ALLOW_MASTER_CRASH: "true" });
  for (const stage of ["production", "staging", "Test-pr-12", "pretest-1", "test"])
    assert.deepEqual(await binding(stage), {}, `stage ${stage} must not carry the binding`);
});
