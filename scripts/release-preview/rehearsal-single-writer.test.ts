import assert from "node:assert/strict";
import { test } from "node:test";
import { singleWriterSteps, type SingleWriterHooks } from "./rehearsal-single-writer.ts";

function hooks(overrides: Partial<SingleWriterHooks> = {}) {
  const events: string[] = [];
  const value: SingleWriterHooks = {
    deployBaseline: async () => void events.push("baseline"),
    shape: async (phase, label) => void events.push(`shape:${phase}:${label}`),
    preflight: async () => (events.push("preflight"), {
      mutations: { deniedStateWrites: 0, blockedHttpMutations: 0, refusedBridgeRequests: {} },
      steps: [{ step: "runtime-bootstrap", status: "pass", summary: { colors: [{ color: "blue", source: "declared" }, { color: "green", source: "declared" }], migrationTag: "untagged" } }],
    }),
    seedPools: async () => (events.push("seed"), { cleanPool: "clean" }),
    release: async (request) => (events.push(`release:${request.candidate}:${request.cleanPool}`), { ok: true }),
    redeploy: async (change) => void events.push(`redeploy:${change}`),
    serve: async () => (events.push("serve"), "served"),
    planWithoutFleetBindings: async () => (events.push("negative"), "~ PoolWorker\n  migrations.deleted_classes: [PoolRuntimeBlue, PoolRuntimeGreen]"),
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
    "negative",
    "serve",
  ]);
  assert.equal(steps.record.steps.length, 11);
  assert.equal(steps.record.negativeControl?.length, 2);
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
  const declared = [{ color: "blue", source: "declared" }, { color: "green", source: "declared" }];
  const step = (status: string, summary: unknown, extra: object = {}) => ({
    mutations: { deniedStateWrites: 0, blockedHttpMutations: 0, refusedBridgeRequests: {} },
    steps: [{ step: "runtime-bootstrap", status, summary }],
    ...extra,
  });
  requireRuntimeBootstrap(step("pass", { colors: declared, migrationTag: "untagged" }));
  for (const report of [
    {},
    step("refused", { colors: declared, migrationTag: "untagged" }),
    step("pass", { colors: declared, migrationTag: "tagged" }),
    step("pass", { colors: declared, migrationTag: "not-needed" }),
    step("pass", { colors: [declared[0], { color: "green", source: "existing" }], migrationTag: "untagged" }),
    step("pass", { colors: [declared[0]], migrationTag: "untagged" }),
    step("pass", { colors: declared, migrationTag: "untagged" }, { fatal: "release-preflight-untrusted-context" }),
    step("pass", { colors: declared, migrationTag: "untagged" }, { mutations: { deniedStateWrites: 1, blockedHttpMutations: 0, refusedBridgeRequests: {} } }),
  ])
    assert.throws(() => requireRuntimeBootstrap(report));
});

test("the negative control refuses a plan that does not delete both fleet classes", async () => {
  const { requireDeletedFleetClasses } = await import("./rehearsal-single-writer.ts");
  assert.deepEqual(
    requireDeletedFleetClasses("- PoolRuntimeBlue (Cloudflare.DurableObject) delete\n- PoolRuntimeGreen (Cloudflare.DurableObject) delete"),
    ["- PoolRuntimeBlue (Cloudflare.DurableObject) delete", "- PoolRuntimeGreen (Cloudflare.DurableObject) delete"],
  );
  for (const plan of ["~ PoolWorker update", "- PoolRuntimeBlue delete", "PoolRuntimeBlue PoolRuntimeGreen unchanged"])
    assert.throws(() => requireDeletedFleetClasses(plan), /does not delete/);
});
