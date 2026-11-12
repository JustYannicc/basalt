import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { RuntimeFleetReplacement } from "./runtime-fleet/replacement.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";
import type { SlotIdentity, SlotTarget } from "./runtime-slots/contract.ts";

async function fixture() {
  let now = 0;
  const storage = new SlotMemory(),
    state = new RuntimeFleetState(storage, 4, () => now);
  let sequence = 0,
    starts = 0,
    retires = 0,
    drains = 0,
    failStart = false,
    enabled = true;
  const target = (): SlotIdentity => ({
    format: "pool-runtime-slot-v1",
    controllerId: "root",
    slotId: `slot-${++sequence}`,
    instanceId: `instance-${sequence}`,
    homePeerOrdinal: sequence,
    applicationId: "blue",
    applicationVersion: "1",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    bootId: `boot-${sequence}`,
  });
  const old = target();
  await state.reserve(old);
  await state.dispatch(old);
  await state.ready(old);
  now = 100;
  const selected = new Map<string, SlotIdentity>([[old.slotId, old]]),
    cells = new Map<string, FleetCell>();
  const replacement = new RuntimeFleetReplacement({ storage, state, target: async () => target() });
  const cell = (value: SlotTarget): FleetCell => {
    const cached = cells.get(value.slotId);
    if (cached) return cached;
    const next: FleetCell = {
      start: async () => {
        starts++;
        if (failStart) throw new Error("unverified startup");
        const identity = { ...value, bootId: `boot-${value.homePeerOrdinal}` };
        selected.set(value.slotId, identity);
        return identity;
      },
      observe: async () => selected.get(value.slotId),
      selected: async () => selected.get(value.slotId),
      forward: async () => new Response("opaque"),
      install: async () => {},
      abortPool: () => {},
      drain: async () => {
        drains++;
        return { active: 0, known: true };
      },
      retire: async () => {
        retires++;
      },
      retired: async () => true,
    };
    cells.set(value.slotId, next);
    return next;
  };
  const controller = () =>
    new RuntimeFleet({
      state,
      target: async () => target(),
      cell,
      legacyActive: async () => 0,
      currentRequests: () => 0,
      targetActive: 1_000,
      maximum: 4,
      idleMilliseconds: 1,
      now: () => now,
      wrap: (response) => response,
      defer: () => {},
      keepReady: (identity) => replacement.keepReady(identity),
      enabled: () => enabled,
    });
  return {
    storage,
    state,
    replacement,
    controller,
    old,
    target,
    starts: () => starts,
    retires: () => retires,
    drains: () => drains,
    fail: () => {
      failStart = true;
    },
    disable: () => {
      enabled = false;
    },
  };
}

test("replacement becomes ready before the old route drains and held streams veto its retirement", async () => {
  const f = await fixture();
  const held = await f.state.acquire(100);
  const operation = await f.replacement.plan("replace", f.old);
  const fleet = f.controller();
  await fleet.upkeep();
  await f.replacement.upkeep();
  const rows = await f.state.inspect();
  assert.equal(
    rows.find((row) => row.target.slotId === operation.replacement.slotId)?.phase,
    "ready",
  );
  assert.equal(rows.find((row) => row.target.slotId === f.old.slotId)?.phase, "draining");
  await fleet.upkeep();
  assert.equal(f.retires(), 0);
  await held.release();
  await fleet.upkeep();
  await f.replacement.upkeep();
  assert.equal(f.retires(), 1);
  assert.equal((await f.replacement.inspect("replace"))?.status, "retired");
  assert.equal((await f.state.inspect()).length, 1);
  assert.deepEqual(
    await f.replacement.plan("replace", f.old),
    await f.replacement.inspect("replace"),
  );
  assert.equal(f.starts(), 1);
});

test("failed readiness retains the old route across reconstruction and does not dispatch another start", async () => {
  const f = await fixture();
  f.fail();
  await f.replacement.plan("replace", f.old);
  await assert.rejects(f.controller().upkeep(), /unverified startup/);
  await f.controller().upkeep();
  await f.replacement.upkeep();
  assert.equal(f.starts(), 1);
  assert.equal(f.retires(), 0);
  assert.equal(
    (await f.state.inspect()).find((row) => row.target.slotId === f.old.slotId)?.phase,
    "ready",
  );
  assert.equal((await f.replacement.inspect("replace"))?.status, "reserved");
});

test("a lost replacement acknowledgement retains one reservation and a full fleet refuses another", async () => {
  const f = await fixture();
  f.storage.afterCommit = () => {
    throw new Error("synthetic lost ACK");
  };
  await assert.rejects(f.replacement.plan("replace", f.old), /lost ACK/);
  f.storage.afterCommit = () => {};
  const recovered = new RuntimeFleetReplacement({
    storage: f.storage,
    state: f.state,
    target: async () => f.target(),
  });
  await recovered.plan("replace", f.old);
  assert.equal((await f.state.inspect()).length, 2);
  assert.equal(f.starts(), 0);
  await f.state.reserve(f.target());
  await f.state.reserve(f.target());
  await assert.rejects(recovered.plan("overflow", f.old), /capacity/);
  assert.equal(await recovered.inspect("overflow"), undefined);
  assert.equal((await f.state.inspect()).length, 4);
});

test("disabling before dispatch cancels the reserved replacement without starting compute", async () => {
  const f = await fixture();
  await f.replacement.plan("replace", f.old);
  f.disable();
  await f.replacement.cancel();
  const fleet = f.controller();
  await fleet.upkeep();
  await fleet.upkeep();
  assert.equal(f.starts(), 0);
  assert.equal(f.retires(), 1);
  assert.equal((await f.replacement.inspect("replace"))?.status, "cancelled");
  assert.deepEqual(await f.state.inspect(), []);
});

test("disabling drains an occupied endpoint immediately but cannot retire it until the held stream completes", async () => {
  const f = await fixture();
  const held = await f.state.acquire(100);
  f.disable();
  const fleet = f.controller();
  await fleet.upkeep();
  const row = (await f.state.inspect())[0]!;
  assert.equal(row.phase, "draining");
  assert.equal(row.active, 1);
  assert.equal(f.drains(), 1);
  assert.equal(f.retires(), 0);
  await held.release();
  await fleet.upkeep();
  assert.equal(f.retires(), 1);
});
