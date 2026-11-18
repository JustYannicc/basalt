import assert from "node:assert/strict";
import { test } from "node:test";
import { singleWriterSteps, type SingleWriterHooks } from "./rehearsal-single-writer.ts";

function hooks(overrides: Partial<SingleWriterHooks> = {}) {
  const events: string[] = [];
  const value: SingleWriterHooks = {
    deployBaseline: async () => void events.push("baseline"),
    shape: async (phase, label) => void events.push(`shape:${phase}:${label}`),
    preflight: async () => (events.push("preflight"), {
      steps: [{ step: "runtime-bootstrap", status: "pass", summary: { blue: "declared", green: "declared", migrationTag: "untagged" } }],
    }),
    seedPools: async () => (events.push("seed"), { cleanPool: "clean" }),
    release: async (request) => (events.push(`release:${request.candidate}:${request.cleanPool}`), { ok: true }),
    redeploy: async (change) => void events.push(`redeploy:${change}`),
    serve: async () => (events.push("serve"), "served"),
    ...overrides,
  };
  return { events, value };
}

test("the plan's steps run in order: untagged seed, release, then two plain deploys that change nothing", async () => {
  const { events, value } = hooks();
  const steps = singleWriterSteps(value);
  await steps.deploy();
  await steps.seed();
  assert.equal(await steps.smoke(), "served");
  assert.deepEqual(events, [
    "baseline",
    "shape:baseline:baseline",
    "preflight",
    "seed",
    "release:candidate:clean",
    "shape:classes:released",
    "redeploy:false",
    "shape:classes:redeployed",
    "redeploy:true",
    "shape:classes:redeployed-env",
    "serve",
  ]);
  assert.equal(steps.record.steps.length, 10);
});

test("a refused release or a shape change stops the rehearsal at that step", async () => {
  const refused = singleWriterSteps(hooks({ release: async () => ({ ok: false, reason: "declared-class-container-drift" }) }).value);
  await refused.deploy();
  await refused.seed();
  await assert.rejects(refused.smoke(), /declared-class-container-drift/);
  assert.equal(refused.record.release?.ok, false);
  const drift = hooks({
    shape: async (phase, label) => {
      if (label === "redeployed") throw new Error("PoolWorker shape refused (classes): a later deploy changed the fleet class namespaces");
    },
  });
  const steps = singleWriterSteps(drift.value);
  await steps.deploy();
  await steps.seed();
  await assert.rejects(steps.smoke(), /changed the fleet class namespaces/);
  assert.ok(!steps.record.steps.includes("3-shape-unchanged"));
});

test("the preflight must pass runtime-bootstrap with both colors declared on an untagged PoolWorker", async () => {
  const { requireRuntimeBootstrap } = await import("./rehearsal-single-writer.ts");
  const step = (status: string, summary: unknown) => ({ steps: [{ step: "runtime-bootstrap", status, summary }] });
  requireRuntimeBootstrap(step("pass", { blue: "declared", green: "declared", migrationTag: "untagged" }));
  for (const report of [
    {},
    step("refused", { blue: "declared", green: "declared", migrationTag: "untagged" }),
    step("pass", { blue: "declared", green: "declared", migrationTag: "v1" }),
    step("pass", { blue: "declared", green: "missing", migrationTag: "untagged" }),
  ])
    assert.throws(() => requireRuntimeBootstrap(report));
});
