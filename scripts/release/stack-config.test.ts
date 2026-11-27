import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import * as AlchemyState from "alchemy/State";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import {
  SHARED_STATE_VERSION,
  stackConfig,
  stackConfigs,
  stackRunsOn,
  stateStoreRefusal,
} from "./stack-config.ts";

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
      state: "shared",
    });
});

test("the emulated upstream stack is accepted from the cloud app and from the repo root, on runner-local State", () => {
  for (const [value, cwd] of [
    ["../../../../scripts/emulated-upstream/stack.ts", cloud],
    ["scripts/emulated-upstream/stack.ts", root],
  ] as const)
    assert.deepEqual(stackConfig(value, root, cwd), {
      config: "scripts/emulated-upstream/stack.ts",
      scaleStack: false,
      state: "runner-local",
    });
});

test("no config is the production stack; the scale stack is matched by its suffix", () => {
  assert.deepEqual(stackConfig(undefined, root, cloud), {
    config: "alchemy.run.ts",
    scaleStack: false,
    state: "shared",
  });
  const scale = resolve("/frozen/candidate/scripts/scale-test/stack.ts");
  assert.deepEqual(stackConfig(scale, root, cloud), {
    config: scale,
    scaleStack: true,
    state: "runner-local",
  });
});

test("of the listed stacks only the emulated upstream is on runner-local State; the rest stay shared", () => {
  assert.deepEqual(
    stackConfigs.filter((stack) => stack.state === "runner-local").map((stack) => stack.path),
    ["scripts/emulated-upstream/stack.ts"],
  );
  for (const stack of stackConfigs)
    assert.equal(stackConfig(stack.path, root, root).state, stack.state, stack.path);
});

// The store Alchemy's own `localState()` builds: what the emulated stack's module configures.
const alchemyLocalStore = async () => {
  const store = await Effect.runPromise(
    Effect.flatten(AlchemyState.State).pipe(
      Effect.provide(AlchemyState.localState()),
      Effect.provide(PlatformServices),
    ),
  );
  return { id: store.id, version: await Effect.runPromise(store.getVersion()) };
};
const runnerLocal = AlchemyState.STATE_STORE_VERSION;

test("Alchemy's local state answers the version the entry imports from Alchemy, under its own id", async () => {
  assert.deepEqual(await alchemyLocalStore(), { id: "local", version: runnerLocal });
  // Production's pin differs; if a future Alchemy made them equal, the store id still decides.
  assert.notEqual(runnerLocal, SHARED_STATE_VERSION);
});

test("the emulated stack's local State is expected at Alchemy's version on its test stage", async () => {
  const local = await alchemyLocalStore();
  for (const stage of ["test-emulated-upstream", "test-pr-12"])
    assert.equal(stateStoreRefusal(local, "runner-local", stage, runnerLocal), undefined, stage);
  // The expectation follows the Alchemy the entry runs, not a number written here.
  assert.equal(
    stateStoreRefusal({ id: "local", version: 9 }, "runner-local", "test-emulated-upstream", 9),
    undefined,
  );
});

test("a production or scale stage carrying the runner-local declaration keeps the pin at 8", async () => {
  const local = await alchemyLocalStore();
  for (const stage of [
    "production",
    "scale-180",
    "",
    "Test-emulated-upstream",
    "emulated-upstream",
  ]) {
    const refused = stateStoreRefusal(local, "runner-local", stage, runnerLocal);
    assert.equal(refused?._tag, "StateStoreRefused", stage);
    assert.equal(refused?.rule, "version", stage);
    assert.equal(refused?.why, `State store version ${runnerLocal}, expected 8.`, stage);
  }
});

test("a stack admitted on runner-local State is refused when its store is not Alchemy's local one", () => {
  // The shared store answers 8; a store answering Alchemy's own number is refused just the same.
  for (const store of [
    { id: "cloudflare-http", version: SHARED_STATE_VERSION },
    { id: "http", version: runnerLocal },
    { id: "inmemory", version: runnerLocal },
  ]) {
    const refused = stateStoreRefusal(store, "runner-local", "test-emulated-upstream", runnerLocal);
    assert.equal(refused?.rule, "store", store.id);
    assert.match(
      refused?.why ?? "",
      /admitted on runner-local State, but its configured store is /u,
    );
  }
});

test("every stack on the shared store keeps the pin at 8 on every stage, test stages included", async () => {
  const local = await alchemyLocalStore();
  const shared = stackConfigs.filter((stack) => stack.state === "shared");
  assert.ok(shared.length >= 4);
  for (const stack of shared)
    for (const stage of [
      "production",
      "test-emulated-upstream",
      "test-rehearsal-2",
      "test-pr-12",
    ]) {
      const at = `${stack.path} on ${stage}`;
      const pinned = { id: "cloudflare-http", version: SHARED_STATE_VERSION };
      assert.equal(stateStoreRefusal(pinned, stack.state, stage, runnerLocal), undefined, at);
      for (const store of [local, { id: "cloudflare-http", version: 7 }]) {
        const refused = stateStoreRefusal(store, stack.state, stage, runnerLocal);
        assert.equal(refused?.rule, "version", at);
        assert.equal(refused?.why, `State store version ${store.version}, expected 8.`, at);
      }
    }
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
      // A runner-local stack meets the State rule on production first; either refusal holds it.
      assert.match(
        refused.output,
        new RegExp(
          `The stack ${config.replaceAll(".", "\\.")} does not run on stage ${stage}|A stack on runner-local State never deploys to production`,
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

test("the entry refuses a runner-local stack on production before anything loads, and only that", () => {
  // What a production job carries, so the refusal is the State rule's, not the job check's.
  const job = { GITHUB_ACTIONS: "true", BASALT_RELEASE_CANDIDATE: "a".repeat(40) };
  const refusal = /A stack on runner-local State never deploys to production/u;
  for (const config of [
    "scripts/emulated-upstream/stack.ts",
    resolve("/frozen/candidate/scripts/scale-test/stack.ts"),
  ])
    for (const command of ["plan", "apply", "deploy", "preflight", "destroy"])
      for (const env of [job, {}]) {
        const refused = runEntryWith(env, command, "--stage", "production", "--config", config);
        assert.notEqual(refused.status, 0, `${command} ${config}`);
        assert.match(refused.output, refusal, `${command} ${config}`);
      }
  // A shared stack on production passes the rule and stops at the production check after it.
  for (const config of [
    undefined,
    ...stackConfigs.filter((s) => s.state === "shared").map((s) => s.path),
  ]) {
    const args = ["deploy", "--stage", "production", ...(config ? ["--config", config] : [])];
    const stopped = runEntryWith(job, ...args);
    assert.notEqual(stopped.status, 0, String(config));
    assert.doesNotMatch(stopped.output, refusal, String(config));
    assert.match(stopped.output, /Production applies only a reviewed plan digest/u, String(config));
  }
});
