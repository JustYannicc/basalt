import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingPlacementRepair, placementRepairTargets } from "./pending-placement.ts";

for (const target of placementRepairTargets)
  test(`pending repair is closed to the exact ${target.role} deployment and only its approved damage`, () => {
    const prior = {
      id: target.prior,
      limits: target.role === "Api" ? { subrequests: 50000 } : undefined,
      placement: {
        mode: "targeted",
        target: [{ id: 39, region: "aws:eu-central-1", type: "region" }],
      },
    };
    const input = {
      role: target.role,
      scriptName: target.scriptName,
      deploymentId: target.deployment,
      baseline: [{ versionId: target.version, percentage: 100 }],
      active: { id: target.version, placement: undefined },
      prior,
      metadata: {
        placement: { region: "aws:eu-central-1" },
        ...(target.role === "Api" ? { limits: { subrequests: 50000 } } : {}),
      },
      settings: { placement: undefined },
      retired: false,
    };
    assert.equal(pendingPlacementRepair(input).disposition, "pending-placement-repair");
    for (const changed of [
      { retired: true },
      { deploymentId: "later-rollback-deployment" },
      { scriptName: "unlisted" },
      { baseline: [{ versionId: target.version, percentage: 50 }] },
      { prior: { ...prior, id: "other-version" } },
      { metadata: { placement: { region: "aws:us-east-1" } } },
      { settings: { placement: undefined, logpush: true } },
    ])
      assert.throws(() => pendingPlacementRepair({ ...input, ...changed }));
  });

test("repair readback refuses missing or different version and live placement", async () => {
  const { assertRepairedPlacement, assertRepairedVersionPlacement } =
    await import("./pending-placement.ts");
  const version = {
    id: "new",
    placement: {
      mode: "targeted",
      target: [{ id: 39, region: "aws:eu-central-1", type: "region" }],
    },
  };
  assert.doesNotThrow(() =>
    assertRepairedPlacement("Api", "new", version, {
      placement: { mode: "targeted", target: [39] },
    }),
  );
  for (const invalid of [
    { ...version, id: "other" },
    { ...version, placement: undefined },
  ])
    assert.throws(
      () => assertRepairedVersionPlacement("Api", "new", invalid),
      /placement-repair-version-drift/,
    );
  assert.throws(
    () => assertRepairedPlacement("Api", "new", version, {}),
    /placement-repair-readback-drift/,
  );
  assert.throws(
    () =>
      assertRepairedPlacement("Api", "new", version, {
        placement: { mode: "targeted", target: [40] },
      }),
    /placement-repair-readback-drift/,
  );
});

test("successful repairs retire independently in durable state", async () => {
  const { Effect } = await import("effect");
  const { InMemoryService } = await import("alchemy/State/InMemoryState");
  const { retiredPlacements, retirePlacement } = await import("./placement-retirement.ts");
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InMemoryService();
      const stack = { name: "basalt", stage: "production" };
      assert.deepEqual(yield* retiredPlacements(state, stack), []);
      yield* retirePlacement(state, stack, "Api");
      assert.deepEqual(yield* retiredPlacements(state, stack), ["Api"]);
      yield* retirePlacement(state, stack, "AppPages");
      yield* retirePlacement(state, stack, "Api");
      assert.deepEqual(yield* retiredPlacements(state, stack), ["Api", "AppPages"]);
    }),
  );
});

test("Api limit exception requires its exact prior limit and excludes AppPages", () => {
  const target = placementRepairTargets[0];
  const prior = {
    id: target.prior,
    placement: {
      mode: "targeted",
      target: [{ id: 39, region: "aws:eu-central-1", type: "region" }],
    },
    limits: { subrequests: 50000 },
  };
  const input = {
    role: target.role,
    scriptName: target.scriptName,
    deploymentId: target.deployment,
    baseline: [{ versionId: target.version, percentage: 100 }],
    active: { id: target.version, placement: undefined },
    prior,
    metadata: { placement: { region: "aws:eu-central-1" }, limits: { subrequests: 50000 } },
    settings: {},
    retired: false,
  };
  const repair = pendingPlacementRepair(input);
  assert.equal(repair.limits?.subrequests.after, 50000);
  for (const bad of [
    { prior: { ...prior, limits: undefined } },
    { prior: { ...prior, limits: { subrequests: 10000 } } },
    { settings: { limits: { subrequests: 10000 } } },
    { active: { ...input.active, limits: { subrequests: 10000 } } },
    { metadata: { ...input.metadata, limits: { subrequests: 50001 } } },
    { metadata: { ...input.metadata, limits: { subrequests: 50000, cpuMs: 100 } } },
  ])
    assert.throws(() => pendingPlacementRepair({ ...input, ...bad }));
  const pages = placementRepairTargets[1];
  assert.throws(
    () =>
      pendingPlacementRepair({
        ...input,
        role: pages.role,
        scriptName: pages.scriptName,
        deploymentId: pages.deployment,
        baseline: [{ versionId: pages.version, percentage: 100 }],
        active: { id: pages.version, placement: undefined },
        prior: { ...prior, id: pages.prior },
      }),
    /script-settings-drift/,
  );
});

test("Api limit readback checks immutable runtime limits and settings around activation", async () => {
  const { assertRepairedVersionPlacement, assertRepairedPlacement } =
    await import("./pending-placement.ts");
  const repair = { limits: { subrequests: { before: null, after: 50000 as const } } };
  const version = {
    id: "new",
    placement: {
      mode: "targeted",
      target: [{ id: 39, region: "aws:eu-central-1", type: "region" }],
    },
    limits: { subrequests: 50000 },
  };
  assert.doesNotThrow(() => assertRepairedVersionPlacement("Api", "new", version, repair));
  for (const limits of [undefined, { subrequests: 10000 }]) {
    assert.throws(
      () => assertRepairedVersionPlacement("Api", "new", { ...version, limits }, repair),
      /limits-repair-version-drift/,
    );
    assert.throws(
      () =>
        assertRepairedPlacement(
          "Api",
          "new",
          version,
          { placement: { mode: "targeted", target: [39] }, limits },
          repair,
        ),
      /limits-repair-readback-drift/,
    );
  }
});
