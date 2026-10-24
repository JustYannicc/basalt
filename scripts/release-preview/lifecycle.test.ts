import assert from "node:assert/strict";
import { test } from "node:test";
import { runPreview, type PreviewHooks } from "./lifecycle.ts";

const result = () => ({ version: 1, mode: "preview", signIn: true, pool: true, cleanup: true,
  clients: ["claude", "codex"].map(client => ({ client, exit: 0, timeout: false,
    modelRequest: true, toolSearch: true, undo: true, revoke: true })) });

function scenario(failures: string[] = []) {
  const calls: string[] = [];
  const operation = async (name: string) => {
    calls.push(name);
    if (failures.includes(name)) throw new Error(`fixed-${name}-failure`);
  };
  const hooks: PreviewHooks = {
    prepare: () => operation("prepare"), deploy: () => operation("deploy"), seed: () => operation("seed"),
    smoke: async () => { await operation("smoke"); return result(); },
    destroy: () => operation("destroy"), verifyAbsent: () => operation("verifyAbsent"),
  };
  return { hooks, calls };
}

test("a successful live smoke still requires verified remote teardown", async () => {
  const { hooks, calls } = scenario();
  assert.equal((await runPreview(hooks)).teardown, true);
  assert.deepEqual(calls, ["prepare", "deploy", "seed", "smoke", "destroy", "verifyAbsent"]);
});

test("a failed provision, seed or smoke always destroys and verifies the temporary stage", async () => {
  for (const failure of ["deploy", "seed", "smoke"]) {
    const { hooks, calls } = scenario([failure]);
    await assert.rejects(runPreview(hooks), new RegExp(`fixed-${failure}-failure`));
    assert.deepEqual(calls.slice(-2), ["destroy", "verifyAbsent"]);
  }
});

test("a secretless preparation failure creates no stage and does not call providers", async () => {
  const { hooks, calls } = scenario(["prepare"]);
  await assert.rejects(runPreview(hooks), /fixed-prepare-failure/);
  assert.deepEqual(calls, ["prepare"]);
});

test("cleanup errors stay red and absence is checked even after destroy fails", async () => {
  for (const failures of [["destroy"], ["verifyAbsent"], ["smoke", "destroy", "verifyAbsent"]]) {
    const { hooks, calls } = scenario(failures);
    await assert.rejects(runPreview(hooks), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, failures.length);
      return true;
    });
    assert.deepEqual(calls.slice(-2), ["destroy", "verifyAbsent"]);
  }
});

test("skips and incomplete runner output cannot create a success receipt", async () => {
  const { hooks, calls } = scenario();
  hooks.smoke = async () => ({ skipped: true });
  await assert.rejects(runPreview(hooks), /missing or incomplete/);
  assert.deepEqual(calls.slice(-2), ["destroy", "verifyAbsent"]);
});
