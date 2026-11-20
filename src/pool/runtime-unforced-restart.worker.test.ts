import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { forcedRestartBudgetMs } from "./runtime-slots/forced-restart-timing.ts";

type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;
interface Recovery {
  needsPerson?: { reason: string };
  unforcedRestartAt?: number;
}

async function crashedRoot(context: TestContext) {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const infos = context.mock.method(console, "info", () => {});
  const errors = context.mock.method(console, "error", () => {});
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  f.old.crash();
  return {
    f,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    phases: () =>
      infos.mock.calls
        .filter((call) => call.arguments[0] === "POOL_SELECTED_RECOVERY")
        .map((call) => (call.arguments[1] as { phase: string }).phase),
    needsPersonLines: () =>
      errors.mock.calls.filter(
        (call) => call.arguments[0] === "POOL_SELECTED_RECOVERY_NEEDS_PERSON",
      ).length,
  };
}
async function pass(f: Fixture) {
  await f.upkeep();
  await f.settle();
}
async function recovery(f: Fixture) {
  return ((await f.send("inspect")) as { recovery: Recovery }).recovery;
}
/** The first pass commits the restart and the second finishes it; then a model call must serve. */
async function servesAfterFix(f: Fixture) {
  await pass(f);
  await pass(f);
  const response = await f.model();
  assert.equal(response.status, 200, await response.text());
  const after = await recovery(f);
  assert.equal(after.needsPerson, undefined, "serving clears it");
  assert.equal(after.unforcedRestartAt, undefined);
}

test(
  "an unforced restart that never commits needs a person, then serves",
  {
    timeout: 30_000,
  },
  async (context) => {
    const { f, advance, needsPersonLines } = await crashedRoot(context);
    let failing = true;
    // Installs only reach the new boot: the restart starts, and never commits.
    f.old.hooks.install = async () => {
      if (failing) throw new Error("synthetic install failure");
    };
    const firstAdmission = Date.now();
    for (let elapsed = 0; elapsed < forcedRestartBudgetMs; elapsed += 10_000) {
      await pass(f);
      advance(10_000);
    }
    const before = await recovery(f);
    assert.equal(before.unforcedRestartAt, firstAdmission, "timed from the first admission");
    assert.equal(before.needsPerson, undefined, "not before the budget");
    await pass(f);
    assert.equal((await recovery(f)).needsPerson?.reason, "restart_failed");
    assert.equal(needsPersonLines(), 1);
    assert.deepEqual(f.old.calls.signals, [], "a restart's own boot is never stopped");
    // Recovery keeps trying: once the fault clears, the same restart commits and serves.
    failing = false;
    await servesAfterFix(f);
    assert.equal(f.old.calls.start, 1);
  },
);

test(
  "an unforced restart that commits but never reaches ready needs a person, then serves",
  {
    timeout: 30_000,
  },
  async (context) => {
    const { f, advance, phases, needsPersonLines } = await crashedRoot(context);
    let failing = true;
    // Installs after the restart attested fail: the commit lands, its final proof never passes.
    f.old.hooks.install = async () => {
      if (failing && phases().includes("attesting"))
        throw new Error("synthetic post-commit failure");
    };
    for (let elapsed = 0; elapsed < forcedRestartBudgetMs; elapsed += 30_000) {
      await pass(f);
      advance(30_000);
    }
    assert.ok(phases().includes("attesting"), "the restart committed");
    assert.equal((await recovery(f)).needsPerson, undefined, "not before the budget");
    await pass(f);
    assert.ok(!phases().includes("ready"), "it never reported ready");
    assert.equal((await recovery(f)).needsPerson?.reason, "restart_failed");
    assert.equal(needsPersonLines(), 1);
    assert.deepEqual(f.old.calls.signals, []);
    failing = false;
    await servesAfterFix(f);
    assert.equal(f.old.calls.start, 1);
  },
);
