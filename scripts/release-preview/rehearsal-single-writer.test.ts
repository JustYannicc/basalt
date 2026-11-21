import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireBaselineProbe,
  requireUndeclaredClassRefused,
  singleWriterSteps,
  type SingleWriterHooks,
} from "./rehearsal-single-writer.ts";
import { baselineRoles } from "../release-barrier/baseline-probe.ts";

const passed = baselineRoles.map((role) => ({ role, ok: true }));

function hooks(overrides: Partial<SingleWriterHooks> = {}) {
  const events: string[] = [];
  const value: SingleWriterHooks = {
    deployBaseline: async () => void events.push("baseline"),
    shape: async (phase, label) => void events.push(`shape:${phase}:${label}`),
    baselineProbe: async (edit) =>
      edit
        ? (events.push("baseline-probe-undeclared"),
          passed.map((row) =>
            row.role === "PoolWorker"
              ? { ...row, ok: false, reason: "durable-object-class-drift" }
              : row,
          ))
        : (events.push("baseline-probe"), passed),
    preflight: async () => (
      events.push("preflight"),
      {
        mutations: { deniedStateWrites: 0, blockedHttpMutations: 0, refusedBridgeRequests: {} },
        steps: [
          {
            step: "runtime-bootstrap",
            status: "pass",
            summary: {
              colors: [
                { color: "blue", source: "declared" },
                { color: "green", source: "declared" },
              ],
              migrationTag: "untagged",
            },
          },
        ],
      }
    ),
    seedPools: async () => (events.push("seed"), { cleanPool: "clean" }),
    release: async (request) => (
      events.push(`release:${request.candidate}:${request.cleanPool}`),
      { ok: true }
    ),
    redeploy: async (change) => void events.push(`redeploy:${change}`),
    serve: async () => (events.push("serve"), "served"),
    planWithoutFleetBindings: async () => (
      events.push("negative"),
      "~ PoolWorker\n  migrations.deleted_classes: [PoolRuntimeBlue, PoolRuntimeGreen]"
    ),
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
    "baseline-probe",
    "baseline-probe-undeclared",
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
  assert.equal(steps.record.steps.length, 13);
  assert.equal(steps.record.negativeControl?.length, 2);
});

test("a refused release or a shape change stops the rehearsal at that step", async () => {
  const refused = singleWriterSteps(
    hooks({ release: async () => ({ ok: false, reason: "declared-class-container-drift" }) }).value,
  );
  await refused.deploy();
  await refused.seed();
  await assert.rejects(refused.smoke(), /declared-class-container-drift/);
  assert.equal(refused.record.release?.ok, false);
  const drift = hooks({
    shape: async (phase, label) => {
      if (label === "redeployed")
        throw new Error(
          "PoolWorker shape refused (classes): a later deploy changed the fleet class namespaces",
        );
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
  const declared = [
    { color: "blue", source: "declared" },
    { color: "green", source: "declared" },
  ];
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
    step("pass", {
      colors: [declared[0], { color: "green", source: "existing" }],
      migrationTag: "untagged",
    }),
    step("pass", { colors: [declared[0]], migrationTag: "untagged" }),
    step(
      "pass",
      { colors: declared, migrationTag: "untagged" },
      { fatal: "release-preflight-untrusted-context" },
    ),
    step(
      "pass",
      { colors: declared, migrationTag: "untagged" },
      { mutations: { deniedStateWrites: 1, blockedHttpMutations: 0, refusedBridgeRequests: {} } },
    ),
  ])
    assert.throws(() => requireRuntimeBootstrap(report));
});

test("the negative control refuses a plan that does not delete both fleet classes", async () => {
  const { requireDeletedFleetClasses } = await import("./rehearsal-single-writer.ts");
  assert.deepEqual(
    requireDeletedFleetClasses(
      "- PoolRuntimeBlue (Cloudflare.DurableObject) delete\n- PoolRuntimeGreen (Cloudflare.DurableObject) delete",
    ),
    [
      "- PoolRuntimeBlue (Cloudflare.DurableObject) delete",
      "- PoolRuntimeGreen (Cloudflare.DurableObject) delete",
    ],
  );
  for (const plan of [
    "~ PoolWorker update",
    "- PoolRuntimeBlue delete",
    "PoolRuntimeBlue PoolRuntimeGreen unchanged",
  ])
    assert.throws(() => requireDeletedFleetClasses(plan), /does not delete/);
});

test("a refused or partial baseline probe stops the rehearsal before any release", async () => {
  requireBaselineProbe(passed);
  const refused = passed.map((row) =>
    row.role === "PoolWorker" ? { ...row, ok: false, reason: "declared-class-drift" } : row,
  );
  assert.throws(() => requireBaselineProbe(refused), /PoolWorker: declared-class-drift/);
  requireBaselineProbe(
    passed.filter((row) => row.role !== "PublicSite" && row.role !== "AppPages"),
  );
  assert.throws(
    () => requireBaselineProbe(passed.filter((row) => row.role !== "PoolWorker")),
    /PoolWorker/,
  );
  assert.throws(() => requireBaselineProbe([...passed, passed[0]]), /once/);
  assert.throws(
    () =>
      requireBaselineProbe([
        ...passed,
        { role: "(inventory)", ok: false, reason: "unexpected-worker" },
      ]),
    /unexpected-worker/,
  );
  assert.throws(() => requireBaselineProbe({}), /PoolWorker/);
  const { events, value } = hooks({ baselineProbe: async () => refused });
  await assert.rejects(singleWriterSteps(value).deploy(), /baseline probe refused/);
  assert.deepEqual(events, ["baseline", "shape:baseline:baseline"]);
});

test("the undeclared-class probe must refuse PoolWorker for its classes and pass every other Worker", () => {
  const refused = (reason: string) =>
    passed.map((row) => (row.role === "PoolWorker" ? { ...row, ok: false, reason } : row));
  requireUndeclaredClassRefused(refused("durable-object-class-drift"));
  requireUndeclaredClassRefused(refused("declared-class-binding-mismatch"));
  assert.throws(() => requireUndeclaredClassRefused(passed), /did not refuse/);
  assert.throws(
    () => requireUndeclaredClassRefused(refused("script-settings-drift")),
    /another reason/,
  );
  assert.throws(
    () =>
      requireUndeclaredClassRefused(
        refused("durable-object-class-drift").map((row) =>
          row.role === "Api" ? { ...row, ok: false, reason: "x" } : row,
        ),
      ),
    /Api: x/,
  );
});
