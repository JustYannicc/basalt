import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nativeSteps,
  planHighlights,
  requireBaselineShape,
  requireCutoverShape,
  type NativeHooks,
  type NativeReadBack,
} from "./rehearsal-native.ts";

const baseline: NativeReadBack = {
  bindings: [
    { name: "POOL_CONTAINER", type: "durable_object_namespace", className: "PoolContainer" },
  ],
  namespaces: ["PoolContainer"],
  applications: [{ name: "basalt-<stage>-pool", className: "PoolContainer", shape: {} }],
};
const cutover: NativeReadBack = {
  bindings: [
    ...baseline.bindings,
    { name: "PoolRuntimeBlue", type: "durable_object_namespace", className: "PoolRuntimeBlue" },
    { name: "PoolRuntimeGreen", type: "durable_object_namespace", className: "PoolRuntimeGreen" },
  ],
  namespaces: ["PoolContainer", "PoolRuntimeBlue", "PoolRuntimeGreen"],
  applications: [
    ...baseline.applications,
    { name: "basalt-<stage>-pool-runtime-blue", className: "PoolRuntimeBlue", shape: {} },
    { name: "basalt-<stage>-pool-runtime-green", className: "PoolRuntimeGreen", shape: {} },
  ],
};

test("refuses a baseline that already binds the fleet", () => {
  requireBaselineShape(baseline);
  assert.throws(() => requireBaselineShape(cutover), /already binds a fleet class/);
});

test("refuses a cutover missing a fleet application", () => {
  requireCutoverShape(cutover);
  assert.throws(
    () => requireCutoverShape({ ...cutover, applications: cutover.applications.slice(0, 2) }),
    /PoolRuntimeGreen application/,
  );
});

test("plans before it applies and records both plans", async () => {
  const calls: string[] = [];
  let applied = false;
  const hooks: NativeHooks = {
    deployBaseline: async () => void calls.push("baseline"),
    readBack: async (label) => (calls.push(`read:${label}`), applied ? cutover : baseline),
    build: async () => void calls.push("build"),
    fleetImages: async () => (calls.push("images"), { blue: "b", green: "g" }),
    plan: async (label) => (calls.push(`plan:${label}`), `+ PoolRuntimeBlue create\nunrelated`),
    apply: async () => {
      calls.push("apply");
      applied = true;
    },
    serve: async () => ({ skipped: "infra-only" }),
  };
  const steps = nativeSteps(hooks);
  await steps.deploy();
  await steps.seed();
  assert.deepEqual(await steps.smoke(), { skipped: "infra-only" });
  assert.deepEqual(calls, [
    "baseline",
    "read:baseline",
    "images",
    "build",
    "plan:cutover",
    "apply",
    "read:cutover",
    "plan:replan",
  ]);
  assert.deepEqual(steps.record.plans.cutover, ["+ PoolRuntimeBlue create"]);
});

test("keeps only the plan lines that say what changes", () => {
  assert.deepEqual(
    planHighlights("noise\n  new_sqlite_classes: PoolRuntimeBlue  \nWorker update\n"),
    ["  new_sqlite_classes: PoolRuntimeBlue", "Worker update"],
  );
});
