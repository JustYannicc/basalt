import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { SlotRefused, type SlotIdentity } from "./runtime-slots/contract.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

// The lane's key for a row: the first 24 hex digits of its slot's SHA-256.
const keyOf = (slotId: string) => createHash("sha256").update(slotId).digest("hex").slice(0, 24);
const go = "coordinator-2026-11-24T0430Z-retire-stuck-row";
const never = async (): Promise<never> => {
  throw new Error("unexpected");
};

/**
 * One fleet row whose six calls lost their releases with the controller's isolate, as row 6f6a32cd
 * did on 24 Nov: its ledger and its cell both still count 6, and nothing lowers either.
 */
async function stuckRow(
  context: TestContext,
  options: {
    phase?: "ready" | "draining";
    stillMs?: number;
    cellMoved?: boolean;
    sibling?: boolean;
    // One of the six calls' releases lands while the cell's override is under way.
    releaseDuring?: boolean;
  } = {},
) {
  const warnings = context.mock.method(console, "warn", () => {});
  context.mock.method(console, "info", () => {});
  let clock = 1_000_000;
  const state = new RuntimeFleetState(new SlotMemory(), 4, () => clock);
  const identities: SlotIdentity[] = [];
  const held: { release(): Promise<void> }[] = [];
  for (const [index, slotId] of (options.sibling
    ? ["slot-stuck", "slot-other"]
    : ["slot-stuck"]
  ).entries()) {
    const target = {
      format: "pool-runtime-slot-v1" as const,
      controllerId: "controller",
      slotId,
      applicationId: "blue",
      applicationVersion: "1",
      instanceId: `instance-${slotId}`,
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageInput: "image",
      homePeerOrdinal: index + 1,
    };
    const identity = { ...target, bootId: `boot-${slotId}` };
    await state.reserve(target);
    await state.dispatch(target);
    await state.ready(identity);
    identities.push(identity);
    // Six calls whose releases never arrive.
    if (index === 0)
      for (let call = 0; call < 6; call++) held.push(await state.acquire(Number.MAX_SAFE_INTEGER));
  }
  const stuck = identities[0]!;
  if ((options.phase ?? "draining") === "draining") await state.drain(stuck);
  clock += options.stillMs ?? 300_000;
  let cellCount = 6;
  const retired: string[] = [];
  const cell: FleetCell = {
    start: never,
    observe: async () => undefined,
    selected: async () => stuck,
    forward: never,
    install: async () => {},
    abortPool: () => {},
    drain: async () => ({ active: cellCount, known: true }),
    activity: async () => ({ active: cellCount, known: true, stillMs: 2_400_000 }),
    checkStill: async () => ({
      refusal: options.cellMoved ? "still_moving" : null,
      active: cellCount,
      stillMs: 2_400_000,
      leases: { current: 0, gone: cellCount },
      connections: 0,
    }),
    releaseStill: async () => {
      if (options.cellMoved) throw new SlotRefused("draining");
      if (options.releaseDuring) await held[0]!.release();
      const released = cellCount;
      cellCount = 0;
      return { released, stillMs: 2_400_000, connections: 0 };
    },
    retire: async (identity, begin) => {
      await begin();
      retired.push(identity.slotId);
      return true;
    },
    retired: async () => true,
    failed: async () => false,
  };
  const fleet = new RuntimeFleet({
    state,
    target: never,
    cell: () => cell,
    legacyActive: async () => 0,
    currentRequests: () => 0,
    targetActive: 25,
    idleMilliseconds: 60_000,
    maximum: 4,
    defer: () => {},
    wrap: (response) => response,
    now: () => clock,
    enabled: () => false,
  });
  const overrides = () =>
    warnings.mock.calls
      .filter((call) => call.arguments[0] === "POOL_FLEET_ROW_RETIRE_OVERRIDE")
      .map((call) => call.arguments[1]);
  const row = async () =>
    (await state.inspect()).find((value) => value.target.slotId === "slot-stuck");
  const advance = (ms: number) => {
    clock += ms;
  };
  return { fleet, state, retired, overrides, row, advance, key: keyOf("slot-stuck") };
}

test("a draining row whose count stood still retires through the ordinary retirement once the operator overrides it", async (context) => {
  const f = await stuckRow(context);
  // Without the override the row never retires: both counts say 6.
  await f.fleet.upkeep();
  assert.deepEqual(
    [(await f.row())?.phase, (await f.row())?.active, f.retired],
    ["draining", 6, []],
  );
  const receipt = await f.fleet.retireRow("fleet-retire-1", go, f.key.slice(0, 8));
  const expected = {
    operationId: "fleet-retire-1",
    go,
    key: f.key,
    slot: "slot-stuck",
    ordinal: 1,
    ledger: 6,
    cell: 6,
    ledgerStillMs: 300_000,
    cellStillMs: 2_400_000,
    ledgerLowered: true,
    connections: 0,
  };
  assert.deepEqual(receipt, expected);
  assert.deepEqual(
    f.overrides(),
    [expected],
    "one closed line names the go, the row and the counts",
  );
  assert.equal((await f.row())?.active, 0);
  await f.fleet.upkeep();
  assert.deepEqual(f.retired, ["slot-stuck"], "the stop is the ordinary retirement's");
  assert.equal(await f.row(), undefined, "the place is released once the instance is proven gone");
});

test("the operator's retirement refuses a ready row, a count that moved, and a key that names no single row", async (context) => {
  for (const [name, options, key, refusal] of [
    ["a ready row", { phase: "ready" }, undefined, /selection/],
    ["a ledger that moved within 300 s", { stillMs: 299_999 }, undefined, /draining/],
    ["a cell count that moved", { cellMoved: true }, undefined, /draining/],
    ["a key that matches no row", {}, "0123456789abcdef", /identity/],
    ["a key that matches two rows", { sibling: true }, "", /identity/],
  ] as const) {
    context.mock.restoreAll();
    const f = await stuckRow(context, options);
    await assert.rejects(f.fleet.retireRow("fleet-retire-1", go, key ?? f.key), refusal, name);
    assert.equal((await f.row())?.active, 6, `${name}: the ledger keeps its count`);
    assert.deepEqual(f.overrides(), [], `${name}: no override line`);
    await f.fleet.upkeep();
    assert.deepEqual(f.retired, [], `${name}: nothing retires`);
  }
});

test("a ledger that moves during the override still gets its line, and upkeep's reconcile finishes it", async (context) => {
  const f = await stuckRow(context, { releaseDuring: true });
  const receipt = await f.fleet.retireRow("fleet-retire-1", go, f.key);
  assert.equal(receipt.ledgerLowered, false, "the ledger moved, so the override doesn't lower it");
  assert.deepEqual(f.overrides(), [receipt], "the cell's override stands, so its line is written");
  assert.equal((await f.row())?.active, 5);
  // Once the ledger stands still again, the ordinary reconcile lowers it to the cell's 0.
  f.advance(300_000);
  await f.fleet.upkeep();
  assert.deepEqual(f.retired, ["slot-stuck"]);
});

test("the operator's check runs every refusal test and the cell's read, and overrides nothing", async (context) => {
  const f = await stuckRow(context);
  const check = await f.fleet.retireCheck(f.key.slice(0, 8));
  assert.deepEqual(check, {
    matches: 1,
    key: f.key,
    ordinal: 1,
    phase: "draining",
    ledger: 6,
    ledgerStillMs: 300_000,
    wouldProceed: true,
    refusal: null,
    cell: 6,
    cellStillMs: 2_400_000,
    leases: { current: 0, gone: 6 },
    connections: 0,
  });
  assert.equal((await f.row())?.active, 6, "the ledger keeps its count");
  assert.deepEqual(f.overrides(), [], "no override line");
  await f.fleet.upkeep();
  assert.deepEqual(f.retired, [], "nothing retires");
  for (const [name, options, key, refusal] of [
    ["a ready row", { phase: "ready" }, undefined, "not_draining"],
    ["a ledger that moved", { stillMs: 299_999 }, undefined, "ledger_moving"],
    ["a cell count that moved", { cellMoved: true }, undefined, "cell_still_moving"],
    ["a key that matches no row", {}, "0123456789abcdef", "key_matches"],
  ] as const) {
    context.mock.restoreAll();
    const g = await stuckRow(context, options);
    const refused = await g.fleet.retireCheck(key ?? g.key);
    assert.deepEqual([refused.wouldProceed, refused.refusal], [false, refusal], name);
    assert.equal((await g.row())?.active, 6, `${name}: the ledger keeps its count`);
  }
});
