import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stackConfig, stackRunsOn } from "./stack-config.ts";

const root = resolve("/repo");
// Previews call the entry from the cloud app, with configs relative to it.
const cloud = resolve(root, ".upstream/apps/hosted/cloud");

test("the rehearsal fixture stack is accepted from the cloud app and from the repo root", () => {
  for (const [value, cwd] of [
    ["../../../../scripts/preview/stack/alchemy.rehearsal-fixture.ts", cloud],
    ["scripts/preview/stack/alchemy.rehearsal-fixture.ts", root],
  ] as const)
    assert.deepEqual(stackConfig(value, root, cwd), {
      config: "scripts/preview/stack/alchemy.rehearsal-fixture.ts",
      scaleStack: false,
    });
});

test("the emulated upstream stack is accepted from the cloud app and from the repo root", () => {
  for (const [value, cwd] of [
    ["../../../../scripts/emulated-upstream/stack.ts", cloud],
    ["scripts/emulated-upstream/stack.ts", root],
  ] as const)
    assert.deepEqual(stackConfig(value, root, cwd), {
      config: "scripts/emulated-upstream/stack.ts",
      scaleStack: false,
    });
});

test("no config is the production stack; the scale stack is matched by its suffix", () => {
  assert.deepEqual(stackConfig(undefined, root, cloud), {
    config: "alchemy.run.ts",
    scaleStack: false,
  });
  const scale = resolve("/frozen/candidate/scripts/scale-test/stack.ts");
  assert.deepEqual(stackConfig(scale, root, cloud), { config: scale, scaleStack: true });
});

test("an unknown config is refused, even one beside the known ones", () => {
  for (const value of [
    "../../../../scripts/preview/stack/alchemy.other.ts",
    "scripts/preview/stack/alchemy.rehearsal-fixture.js",
    "scripts/emulated-upstream/worker.ts",
    "/frozen/candidate/scripts/emulated-upstream/stack.ts",
    "/elsewhere/alchemy.run.ts",
  ])
    assert.throws(() => stackConfig(value, root, cloud), /^Error: Unknown stack config /u);
});

// The entry checks its config and stage before it loads anything or reads a credential, so these
// runs stop at once with an empty environment.
const repo = fileURLToPath(new URL("../../", import.meta.url));
const entry = fileURLToPath(new URL("./deploy.ts", import.meta.url));
const runEntry = (...args: string[]) => runEntryWith({}, ...args);
const runEntryWith = (env: Record<string, string>, ...args: string[]) => {
  const run = spawnSync(process.execPath, [entry, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 60_000,
  });
  // Proves the claim above: nothing reached a provider before the refusal.
  assert.doesNotMatch(run.stdout, /Outgoing requests/u);
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
};

test("the entry admits the emulated stack only on a test-* stage and refuses every unlisted stack", () => {
  const emulated = "scripts/emulated-upstream/stack.ts";
  // Admitted: the run gets past both checks and stops at the next one, a teardown's own stage rule.
  const admitted = runEntry("teardown", "--stage", "test-emulated-upstream", "--config", emulated);
  assert.notEqual(admitted.status, 0);
  assert.match(admitted.output, /A teardown runs only on a test-rehearsal-<n> stage/u);
  const stageRefusal = /The stack scripts\/emulated-upstream\/stack\.ts does not run on stage/u;
  for (const stage of ["emulated-upstream", "scale-1", "Test-emulated-upstream", ""]) {
    const refused = runEntry("plan", "--stage", stage, "--config", emulated);
    assert.notEqual(refused.status, 0, stage);
    assert.match(refused.output, stageRefusal, stage);
  }
  for (const config of [
    "scripts/emulated-upstream/worker.ts",
    "scripts/emulated-upstream/other.ts",
    "/frozen/candidate/scripts/emulated-upstream/stack.ts",
    "scripts/emulated-upstream/stack.js",
  ]) {
    const refused = runEntry("plan", "--stage", "test-emulated-upstream", "--config", config);
    assert.notEqual(refused.status, 0, config);
    assert.match(
      refused.output,
      new RegExp(`Unknown stack config ${config.replaceAll(".", "\\.")}`, "u"),
      config,
    );
  }
});

test("a test-only stack is refused on production and on any stage but its own, before anything loads", () => {
  // As a production run inside Actions: the stage checks after this one would let a plan through.
  const actions = { GITHUB_ACTIONS: "true", BASALT_RELEASE_CANDIDATE: "a".repeat(40) };
  for (const [config, own, other] of [
    ["scripts/preview/stack/alchemy.database.ts", "test-pr-7", "test-rehearsal-1"],
    ["scripts/preview/stack/alchemy.cleanup.ts", "test-pr-7", "test-emulated-upstream"],
    ["scripts/preview/stack/alchemy.rehearsal-fixture.ts", "test-rehearsal-1", "test-pr-7"],
    ["scripts/emulated-upstream/stack.ts", "test-emulated-upstream", "test-pr-7"],
  ] as const) {
    for (const stage of ["production", other]) {
      const refused = runEntryWith(actions, "plan", "--stage", stage, "--config", config);
      assert.notEqual(refused.status, 0, `${config} on ${stage}`);
      assert.match(
        refused.output,
        new RegExp(
          `The stack ${config.replaceAll(".", "\\.")} does not run on stage ${stage}`,
          "u",
        ),
      );
    }
    // On its own stage the rule admits it; nothing past it is run here, since that would load.
    assert.equal(stackRunsOn(config, own), true, `${config} on ${own}`);
  }
  // The production stack still runs on production: it gets past this check to the next one.
  const production = runEntryWith(actions, "deploy", "--stage", "production");
  assert.match(production.output, /Production applies only a reviewed plan digest/u);
});
