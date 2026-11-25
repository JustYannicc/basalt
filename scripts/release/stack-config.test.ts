import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { stackConfig } from "./stack-config.ts";

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

test("the route scratch stack is accepted from the cloud app and from the repo root", () => {
  for (const [value, cwd] of [
    ["../../../../scripts/route-scratch/stack.ts", cloud],
    ["scripts/route-scratch/stack.ts", root],
  ] as const)
    assert.deepEqual(stackConfig(value, root, cwd), {
      config: "scripts/route-scratch/stack.ts",
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
    "scripts/route-scratch/worker.ts",
    "/frozen/candidate/scripts/route-scratch/stack.ts",
    "/elsewhere/alchemy.run.ts",
  ])
    assert.throws(() => stackConfig(value, root, cloud), /^Error: Unknown stack config /u);
});
