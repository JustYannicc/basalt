import assert from "node:assert/strict";
import { test } from "node:test";
import * as Output from "alchemy/Output";
import type * as AlchemyPlan from "alchemy/Plan";
import {
  fleetRebindRows,
  rebindPlanLine,
  recommitFleet,
  recommitLine,
  releaseGo,
  scaleOutLine,
} from "./fleet-recommit.ts";
import { goPattern, runPoolFleet } from "../pool-fleet/dispatch.ts";
import { staleRowsDrainMs } from "../pool-fleet/operations.ts";
import { resolvedApplication } from "../pool-fleet/test/cloudflare-shapes.ts";
import { colours, harness } from "../pool-fleet/test/harness.ts";

/** A Worker row as the plan holds it: its recorded and declared settings, and its binding rows. */
const workerRow = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  rows: readonly (readonly [string, string])[] = [],
) => ({
  resource: { Type: "Cloudflare.Worker" },
  action: "update",
  state: { props: { env: before } },
  props: { env: after },
  bindings: rows.map(([sid, action]) => ({ sid, action })),
});
const planOf = (resources: Record<string, unknown>) =>
  ({ resources }) as unknown as AlchemyPlan.Plan;
const settings = (input: unknown) => ({
  POOL_BLUE_APPLICATION_ID: "app-blue",
  POOL_BLUE_IMAGE_HASH: input,
  POOL_GREEN_APPLICATION_ID: "app-green",
  POOL_GREEN_IMAGE_HASH: input,
  POOL_IMAGE_HASH: "526fa60bed0df442",
});

test("a plan that rebuilds the cells names the pool Worker's image inputs, as such a release plans them", () => {
  // aae136d5 and a958b53c: the pool Worker's settings move to the new input, the colours re-bind.
  const rebuilt = workerRow(settings("2fcc2824d9d8642b"), settings("01236e2686ea4f5b"), [
    ["PoolRuntimeBlue", "update"],
    ["PoolRuntimeGreen", "update"],
  ]);
  assert.deepEqual(fleetRebindRows(planOf({ PoolWorker: rebuilt }), "PoolWorker"), [
    "POOL_BLUE_IMAGE_HASH",
    "POOL_GREEN_IMAGE_HASH",
  ]);
  // Before the colours apply, the planner holds the new input as an expression, as here.
  const pending = Output.literal("hash").pipe(Output.map(() => "01236e2686ea4f5b"));
  assert.ok(Output.isExpr(pending));
  const unresolved = workerRow(settings("2fcc2824d9d8642b"), {
    ...settings("2fcc2824d9d8642b"),
    POOL_BLUE_IMAGE_HASH: pending,
  });
  assert.deepEqual(fleetRebindRows(planOf({ PoolWorker: unresolved }), "PoolWorker"), [
    "POOL_BLUE_IMAGE_HASH",
  ]);
  // A colour on another application is the same stale permission.
  const moved = workerRow(settings("01236e2686ea4f5b"), {
    ...settings("01236e2686ea4f5b"),
    POOL_GREEN_APPLICATION_ID: "app-green-2",
  });
  assert.deepEqual(fleetRebindRows(planOf({ PoolWorker: moved }), "PoolWorker"), [
    "POOL_GREEN_APPLICATION_ID",
  ]);
  assert.match(
    rebindPlanLine(["POOL_BLUE_IMAGE_HASH", "POOL_GREEN_IMAGE_HASH"]),
    /changes the cell image \(POOL_BLUE_IMAGE_HASH, POOL_GREEN_IMAGE_HASH\): the deploy re-commits the fleet permission and proves a cell/u,
  );
});

test("a code-only plan, the root's input and another Worker's settings name no cell binding", () => {
  // 6521a747: the pool Worker's code changes, its cell settings stand.
  const codeOnly = workerRow(
    { ...settings("2fcc2824d9d8642b"), PROD_RELEASE: "6521a747" },
    { ...settings("2fcc2824d9d8642b"), PROD_RELEASE: "aae136d5" },
  );
  assert.deepEqual(fleetRebindRows(planOf({ PoolWorker: codeOnly }), "PoolWorker"), []);
  const root = workerRow(settings("2fcc2824d9d8642b"), {
    ...settings("2fcc2824d9d8642b"),
    POOL_IMAGE_HASH: "203186cf6c035132",
  });
  assert.deepEqual(fleetRebindRows(planOf({ PoolWorker: root }), "PoolWorker"), []);
  const other = workerRow(settings("2fcc2824d9d8642b"), settings("01236e2686ea4f5b"));
  assert.deepEqual(fleetRebindRows(planOf({ Api: other }), "PoolWorker"), []);
});

test("the deploy's own operation key fits the lane's GO and differs for each run and attempt", () => {
  const candidate = "e582d4cb468a53b275a7cf97d69584abac3aa2b4";
  const at = new Date("2026-11-25T18:00:00Z");
  const first = releaseGo(candidate, at, "19733521004", "1");
  assert.equal(first, "coordinator-2026-release-e582d4cb-19733521004-1");
  assert.match(first, goPattern);
  assert.notEqual(releaseGo(candidate, at, "19733521004", "2"), first);
});

const release = {
  go: "coordinator-2026-release-e582d4cb-1-1",
  ref: "refs/heads/main",
  event: "workflow_dispatch",
};
const rows = ["POOL_BLUE_IMAGE_HASH", "POOL_GREEN_IMAGE_HASH"];
/** A release rebuilds both colours: new images, and the pool Worker's settings name them. */
const rebuild = () => {
  const before = { blue: { ...colours.blue }, green: { ...colours.green } };
  colours.blue.image = `sha256:${"9".repeat(64)}`;
  colours.blue.input = "blue-input-rebuilt";
  colours.green.image = `sha256:${"8".repeat(64)}`;
  colours.green.input = "green-input-rebuilt";
  return () => {
    Object.assign(colours.blue, before.blue);
    Object.assign(colours.green, before.green);
  };
};
type Lane = Awaited<ReturnType<typeof harness>>;
const configured = async (lane: Lane) => {
  const first = await runPoolFleet(
    { ...release, mode: "configure-and-accept", go: "coordinator-2026-11-24-fleet" },
    lane.deps(),
  );
  assert.equal(first.ok, true, JSON.stringify(first));
};
const standing = async (lane: Lane) =>
  lane.configuration.standing(await lane.configuration.inspect());
const sent = (lane: Lane) =>
  lane.actions.filter((action) => action === "fleet-configure" || action === "fleet-disable");
/** The lane's waits move this clock, so its bounds run in no real time. */
const clocked = (lane: Lane) => {
  let at = Date.now();
  return { ...lane.deps(), now: () => at, sleep: async (ms: number) => void (at += ms) };
};
const cause = (outcome: Awaited<ReturnType<typeof recommitFleet>>) =>
  "result" in outcome && outcome.result && "cause" in outcome.result
    ? String(outcome.result.cause)
    : "";

test("after a release rebuilds the cells, the re-commit drains the cell of the image before, puts the fleet back in force and a cell serves", async () => {
  const lane = await harness({ drainOnDisable: true });
  const back = rebuild();
  back();
  try {
    await configured(lane);
    assert.deepEqual(await standing(lane), { inForce: true });
    rebuild();
    assert.deepEqual(await standing(lane), { inForce: false, notInForce: "bindings" });
    const outcome = await recommitFleet(rows, release, lane.deps());
    assert.equal(outcome.status, "recommitted", JSON.stringify(outcome));
    assert.equal(recommitLine(outcome).ok, true);
    assert.deepEqual(await standing(lane), { inForce: true });
    // The ready cell of the image before held a row: drained first, then configured anew.
    assert.deepEqual(sent(lane), ["fleet-configure", "fleet-disable", "fleet-configure"]);
    const record = await lane.configuration.inspect();
    assert.equal(record?.configuration.revision, 2);
    for (const app of record!.configuration.applications) {
      assert.equal(app.imageInput, colours[app.color].input);
      assert.equal(app.imageDigest, colours[app.color].image);
    }
  } finally {
    back();
    await lane.close();
  }
});

test("under demand, a configure after a cell image change drains the old cell instead of refusing as uncertain, and a cell on the new image serves", async () => {
  // Before this change: fleet-configure answered slot_uncertain (configuration.ts, assertOccupied)
  // because the old image's ready cell held a row, and the lane disabled the fleet.
  const lane = await harness({ drainOnDisable: true });
  const back = rebuild();
  back();
  try {
    await configured(lane);
    rebuild();
    const result = await runPoolFleet(
      { ...release, mode: "configure-and-accept", go: "coordinator-2026-11-25-repair" },
      lane.deps(),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await standing(lane), { inForce: true });
    const cells = lane.storage.values.get("runtime-fleet-v1:resources") as {
      target: { imageInput: string; imageDigest: string };
    }[];
    assert.deepEqual(
      cells.map(({ target }) => [target.imageInput, target.imageDigest]),
      [[colours.blue.input, colours.blue.image]],
    );
    const accepted = (result as { result?: { acceptance?: { servedByCell?: unknown } } }).result
      ?.acceptance;
    assert.ok(accepted?.servedByCell, JSON.stringify(accepted));
  } finally {
    back();
    await lane.close();
  }
});

test("a cell settings change gives the colour a new application version on the same input, and its cell drains too", async () => {
  const lane = await harness({ drainOnDisable: true });
  const version = resolvedApplication.version;
  try {
    await configured(lane);
    resolvedApplication.version = version + 1;
    const outcome = await recommitFleet(["POOL_BLUE_APPLICATION_ID"], release, lane.deps());
    assert.equal(outcome.status, "recommitted", JSON.stringify(outcome));
    assert.deepEqual(sent(lane), ["fleet-configure", "fleet-disable", "fleet-configure"]);
  } finally {
    resolvedApplication.version = version;
    await lane.close();
  }
});

test("a fleet an operator turned off, or never configured, stays as it is: the release sends nothing", async () => {
  const off = await harness({ drainOnDisable: true });
  const back = rebuild();
  back();
  try {
    await configured(off);
    const disabled = await runPoolFleet(
      { ...release, mode: "disable", go: "coordinator-2026-11-25-operator-off" },
      off.deps(),
    );
    assert.equal(disabled.ok, true, JSON.stringify(disabled));
    rebuild();
    const before = sent(off).length;
    const outcome = await recommitFleet(rows, release, off.deps());
    assert.deepEqual(outcome, { status: "fleet-off", off: "fleet-disabled" });
    assert.equal(recommitLine(outcome).ok, true);
    assert.equal(sent(off).length, before);
    assert.equal((await off.configuration.inspect())?.enabled, false);
  } finally {
    back();
    await off.close();
  }
  const absent = await harness();
  try {
    assert.deepEqual(await recommitFleet(rows, release, absent.deps()), {
      status: "fleet-off",
      off: "fleet-absent",
    });
    assert.deepEqual(sent(absent), []);
    assert.equal(await absent.configuration.inspect(), undefined);
  } finally {
    await absent.close();
  }
});

test("a fleet an operator turns off while the release runs, after its first read and before its send, stays off", async () => {
  let rolling = true;
  const lane = await harness({ drainOnDisable: true, rolling: () => rolling });
  const back = rebuild();
  back();
  try {
    rolling = false;
    await configured(lane);
    rebuild();
    rolling = true;
    const before = sent(lane).length;
    // The release read the fleet on; while it waits out a rollout, an operator disables it.
    const outcome = await recommitFleet(rows, release, {
      ...lane.deps(),
      sleep: async () => {
        if (!rolling) return;
        rolling = false;
        const current = await lane.configuration.inspect();
        await lane.configuration.disable("disable-operator-mid-release", current!.digest);
      },
    });
    assert.deepEqual(outcome, { status: "fleet-off", off: "fleet-disabled", during: true });
    const { ok, line } = recommitLine(outcome);
    assert.equal(ok, true);
    assert.match(line, /turned off while this release ran: it stays off/u);
    assert.equal(sent(lane).length, before);
    const record = await lane.configuration.inspect();
    assert.equal(record?.enabled, false);
    assert.equal(record?.operationId, "disable-operator-mid-release");
  } finally {
    rolling = false;
    back();
    await lane.close();
  }
});

test("a release with no cell binding says scale-out is off when the fleet is disabled, and fails when it cannot read it", async () => {
  const off = await harness({ drainOnDisable: true });
  try {
    await configured(off);
    const disabled = await runPoolFleet(
      { ...release, mode: "disable", go: "coordinator-2026-11-25-operator-off" },
      off.deps(),
    );
    assert.equal(disabled.ok, true, JSON.stringify(disabled));
    const outcome = await recommitFleet([], release, off.deps());
    assert.equal(outcome.status, "not-needed");
    const { ok, warn, line } = recommitLine(outcome);
    assert.deepEqual([ok, warn], [true, true]);
    assert.match(line, /the fleet is disabled: scale-out is OFF/u);
  } finally {
    await off.close();
  }
  const lost = await harness({
    handoffFailure: (action) =>
      action === "fleet-inspect" ? new Error("bridge reset") : undefined,
  });
  try {
    const outcome = await recommitFleet([], release, clocked(lost));
    assert.equal(outcome.status, "unread", JSON.stringify(outcome));
    const { ok, line } = recommitLine(outcome);
    assert.equal(ok, false);
    assert.match(line, /could not be read after the deploy .*Scale-out may be OFF/u);
  } finally {
    await lost.close();
  }
});

test("a release with no cell binding reads the permission, and fails when an earlier run left it out of force", async () => {
  const lane = await harness();
  const back = rebuild();
  back();
  try {
    const none = await recommitFleet([], release, lane.deps());
    assert.equal(none.status, "not-needed", JSON.stringify(none));
    await configured(lane);
    const standingOk = await recommitFleet([], release, lane.deps());
    assert.equal(standingOk.status, "not-needed");
    assert.equal(recommitLine(standingOk).ok, true);
    // The cells were rebuilt by a run that never re-committed: the next plan has no rows.
    rebuild();
    const left = await recommitFleet([], release, lane.deps());
    assert.equal(left.status, "out-of-force", JSON.stringify(left));
    assert.equal(recommitLine(left).ok, false);
    assert.deepEqual(sent(lane), ["fleet-configure"]);
  } finally {
    back();
    await lane.close();
  }
});

test("a run whose operation key already configured an older fleet fails instead of passing on a permission out of force", async () => {
  const lane = await harness();
  const back = rebuild();
  back();
  try {
    const first = await runPoolFleet({ ...release, mode: "configure-and-accept" }, lane.deps());
    assert.equal(first.ok, true, JSON.stringify(first));
    rebuild();
    const outcome = await recommitFleet(["POOL_BLUE_IMAGE_HASH"], release, lane.deps());
    assert.equal(outcome.status, "failed");
    assert.deepEqual(await standing(lane), { inForce: false, notInForce: "bindings" });
  } finally {
    back();
    await lane.close();
  }
});

test("a cell that never leaves its drain ends the re-commit red at the bound, naming it, with the fleet disabled", async () => {
  const lane = await harness();
  const back = rebuild();
  back();
  try {
    await configured(lane);
    rebuild();
    const deps = clocked(lane);
    const from = deps.now();
    const outcome = await recommitFleet(rows, release, deps);
    assert.equal(outcome.status, "failed");
    assert.match(cause(outcome), /^stale-rows-remain: 1 rows still occupy the fleet 435 s after/u);
    assert.match(cause(outcome), /: [0-9a-f]{24} ready with 0 streams counted\./u);
    assert.ok(deps.now() - from >= staleRowsDrainMs);
    assert.equal((await lane.configuration.inspect())?.enabled, false);
    // Its last line says scale-out is off, and names the run that turns it back on.
    const { ok, line } = recommitLine(outcome);
    assert.equal(ok, false);
    assert.match(
      line,
      /Scale-out is OFF: the fleet is disabled and the root serves alone at its cap\. One run of the Pool fleet workflow brings it back: mode configure-and-accept/u,
    );
    // A clock that never moves still ends the drain, after one read per poll of its bound.
    const frozen = { ...lane.deps(), sleep: async () => {}, now: () => from };
    const again = await runPoolFleet(
      { ...release, mode: "configure-and-accept", go: "coordinator-2026-11-25-frozen" },
      frozen,
    );
    assert.match(String("cause" in again ? again.cause : ""), /^stale-rows-remain/u);
  } finally {
    back();
    await lane.close();
  }
});

test("a colour Cloudflare still rolls is waited for before anything is sent", async () => {
  let reads = 0;
  const lane = await harness({
    drainOnDisable: true,
    rolling: (id) => id === colours.blue.id && reads++ < 3,
  });
  const back = rebuild();
  back();
  try {
    await configured(lane);
    reads = 0;
    rebuild();
    const outcome = await recommitFleet(rows, release, clocked(lane));
    assert.equal(outcome.status, "recommitted", JSON.stringify(outcome));
  } finally {
    back();
    await lane.close();
  }
  const stuck = await harness({ drainOnDisable: true, rolling: () => stuckRolling });
  let stuckRolling = false;
  try {
    await configured(stuck);
    rebuild();
    stuckRolling = true;
    const outcome = await recommitFleet(rows, release, clocked(stuck));
    assert.equal(outcome.status, "failed");
    assert.match(cause(outcome), /application-rollout-active/u);
    // Refused before the drain: the fleet is as it was, on and out of force.
    assert.deepEqual(sent(stuck), ["fleet-configure"]);
    assert.equal((await stuck.configuration.inspect())?.enabled, true);
  } finally {
    stuckRolling = false;
    back();
    await stuck.close();
  }
});

const models = ["claude-opus-5-5", "gpt-6.1-sol"];

test("a quota refusal on the acceptance model moves to the next, as the deploy's smoke does", async () => {
  const lane = await harness({
    drainOnDisable: true,
    models,
    quota: (model) => (model === "claude-opus-5-5" ? "usage_credit_policy_denied" : undefined),
  });
  const back = rebuild();
  back();
  try {
    await runPoolFleet(
      { ...release, mode: "configure-and-accept", go: "coordinator-2026-11-24-fleet" },
      { ...lane.deps(), acceptance: { ...lane.deps().acceptance, model: "gpt-6.1-sol" } as never },
    );
    rebuild();
    const deps = lane.deps();
    const outcome = await recommitFleet(rows, release, {
      ...deps,
      acceptance: { ...deps.acceptance, model: "claude-opus-5-5" } as never,
    });
    assert.equal(outcome.status, "recommitted", JSON.stringify(outcome));
    const accepted = (
      outcome as {
        result: { result?: { acceptance?: { model?: string; quotaRefused?: string[] } } };
      }
    ).result.result?.acceptance;
    assert.equal(accepted?.model, "gpt-6.1-sol");
    assert.deepEqual(accepted?.quotaRefused, [
      "claude-opus-5-5: usage_credit_policy_denied, HTTP 429",
    ]);
  } finally {
    back();
    await lane.close();
  }
});

/** A fleet configured on the old cells, then rebuilt, with every turn refused as `quota` once on. */
async function quotaLane(quota: "usage_credit_policy_denied" | "model_cooldown") {
  let refusing = false;
  const lane = await harness({
    drainOnDisable: true,
    models,
    quota: () => (refusing ? quota : undefined),
  });
  const back = rebuild();
  back();
  const deps = lane.deps();
  const model = { ...deps, acceptance: { ...deps.acceptance, model: "claude-opus-5-5" } as never };
  const first = await runPoolFleet(
    { ...release, mode: "configure-and-accept", go: "coordinator-2026-11-24-fleet" },
    model,
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  rebuild();
  refusing = true;
  return {
    lane,
    outcome: await recommitFleet(rows, release, model),
    close: async () => {
      back();
      await lane.close();
    },
  };
}

test("every acceptance model refused for funding fails the release, and the new permission stays in force", async () => {
  const { lane, outcome, close } = await quotaLane("usage_credit_policy_denied");
  try {
    assert.equal(outcome.status, "unproven", JSON.stringify(outcome));
    assert.match(
      cause(outcome),
      /^acceptance-quota-refused: .*claude-opus-5-5: usage_credit_policy_denied, HTTP 429; gpt-6\.1-sol: usage_credit_policy_denied, HTTP 429/u,
    );
    const { ok, line } = recommitLine(outcome);
    assert.equal(ok, false);
    assert.match(line, /stays in force/u);
    // Not disabled: cells can start, and nothing about them failed.
    assert.deepEqual(sent(lane), ["fleet-configure", "fleet-disable", "fleet-configure"]);
    assert.deepEqual(await standing(lane), { inForce: true });
  } finally {
    await close();
  }
});

test("a cell whose node cools every model is a cell that fails to serve: the fleet is disabled and the root proven", async () => {
  const { lane, outcome, close } = await quotaLane("model_cooldown");
  try {
    assert.equal(outcome.status, "failed", JSON.stringify(outcome));
    assert.match(cause(outcome), /^acceptance-cooldown-refused: /u);
    assert.equal((await lane.configuration.inspect())?.enabled, false);
    assert.match(recommitLine(outcome).line, /Scale-out is OFF: the fleet is disabled/u);
  } finally {
    await close();
  }
});

test("a cell that fails to serve after the re-commit disables the fleet, proves the root, and the last line says scale-out is off", async () => {
  let broken = false;
  const lane = await harness({
    drainOnDisable: true,
    turnStatus: () => (broken ? 500 : undefined),
  });
  const back = rebuild();
  back();
  try {
    await configured(lane);
    rebuild();
    broken = true;
    const outcome = await recommitFleet(rows, release, lane.deps());
    assert.equal(outcome.status, "failed", JSON.stringify(outcome));
    assert.ok(
      (outcome as { result?: { rollback?: { disabled?: unknown } } }).result?.rollback?.disabled,
    );
    assert.equal((await lane.configuration.inspect())?.enabled, false);
    assert.match(recommitLine(outcome).line, /Scale-out is OFF: the fleet is disabled/u);
  } finally {
    back();
    await lane.close();
  }
});

test("a fleet step that could not start says nothing was sent, and what the cells' change left", () => {
  const changed = recommitLine({ status: "failed", cause: "TypeError", notStarted: true, rows: 2 });
  assert.equal(changed.ok, false);
  assert.match(
    changed.line,
    /could not start \(TypeError\): nothing was sent\. This release changed the cell image/u,
  );
  assert.match(
    changed.line,
    /new cells cannot start until one run of the Pool fleet workflow re-commits the fleet/u,
  );
  const same = recommitLine({ status: "failed", cause: "TypeError", notStarted: true, rows: 0 });
  assert.match(same.line, /nothing was sent\. The fleet stands as it was before this release\./u);
  // The step after a deploy that died says where scale-out stands from one read, or that it can't.
  assert.match(scaleOutLine(undefined), /^Scale-out may be OFF: the fleet could not be read/u);
  assert.match(
    scaleOutLine({ enabled: false, inForce: false, notInForce: "disabled", rows: 0 }),
    /^Scale-out is OFF: the fleet is disabled/u,
  );
  assert.equal(
    scaleOutLine({ enabled: true, inForce: true, notInForce: null, rows: 1 }),
    "Scale-out is on: the fleet is enabled and in force.",
  );
});
