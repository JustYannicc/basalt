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

test("only a rehearsal stage names itself to the Worker, as the fault command's check expects", async () => {
  const { rehearsalStageBinding } = await import("./deployment.ts");
  const { rehearsalStagePattern } = await import("./runtime-slots/rehearsal-fault.ts");
  const named = (stage: string) =>
    Effect.runPromise(rehearsalStageBinding.pipe(Effect.provideService(Stage, stage)));
  for (const stage of ["test-rehearsal-1", "test-rehearsal-81221"]) {
    assert.deepEqual(await named(stage), { POOL_REHEARSAL_STAGE: stage });
    assert.ok(rehearsalStagePattern.test(stage));
  }
  for (const stage of [
    "production",
    "test-pr-12",
    "test-rehearsal-0",
    "test-rehearsal-",
    "x-test-rehearsal-1",
  ]) {
    assert.deepEqual(await named(stage), {}, `stage ${stage} must not carry the binding`);
    assert.ok(!rehearsalStagePattern.test(stage));
  }
});
