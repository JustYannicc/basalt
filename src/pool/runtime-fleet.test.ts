import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import type { SlotIdentity } from "./runtime-slots/contract.ts";
import { nativeMembershipKey, slotSelectionKey } from "./runtime-slots/storage.ts";
import { runtimeCellState } from "./runtime-fleet/cell-state.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

const identity = (index: number): SlotIdentity => ({
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: `slot-${index}`,
  applicationId: "blue",
  applicationVersion: "1",
  instanceId: `instance-${index}`,
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageInput: "image-input",
  homePeerOrdinal: index,
  bootId: `boot-${index}`,
});
async function ready(state: RuntimeFleetState, index: number) {
  const target = identity(index);
  await state.reserve(target);
  await state.dispatch(target);
  await state.ready(target);
  return target;
}

test("the retained primary and two runtimes share load while primary reservations survive reconstruction", async () => {
  const memory = new SlotMemory(),
    state = new RuntimeFleetState(memory, 4);
  await ready(state, 1);
  await ready(state, 2);
  const reservations = await Promise.all(Array.from({ length: 6 }, () => state.acquire(100, true)));
  assert.equal(reservations.filter((value) => value.kind === "primary").length, 2);
  assert.deepEqual(
    (await state.inspect()).map((row) => row.active),
    [2, 2],
  );
  assert.equal(await new RuntimeFleetState(memory, 4).primaryActive(), 2);
  await Promise.all(reservations.map((value) => value.release()));
  assert.equal(await state.primaryActive(), 0);
  assert.deepEqual(
    (await state.inspect()).map((row) => row.active),
    [0, 0],
  );
});

test("concurrent demand counts every reserved, warming, draining and uncertain runtime against four", async () => {
  const memory = new SlotMemory();
  const state = new RuntimeFleetState(memory, 4);
  const first = await ready(state, 1);
  await state.drain(first);
  await state.reserve(identity(2));
  await state.dispatch(identity(2));
  await state.uncertain(identity(2));
  const results = await Promise.allSettled(
    [3, 4, 5, 6].map((index) => state.reserve(identity(index))),
  );
  assert.equal(results.filter((value) => value.status === "fulfilled").length, 2);
  assert.equal((await state.inspect()).length, 4);
  await assert.rejects(state.dispatch(identity(2)), /uncertain/);
});

test("lost dispatch acknowledgement survives reconstruction without a second launch", async () => {
  const memory = new SlotMemory();
  const target = identity(1);
  await new RuntimeFleetState(memory, 4).reserve(target);
  memory.afterCommit = () => {
    throw new Error("lost acknowledgement");
  };
  await assert.rejects(new RuntimeFleetState(memory, 4).dispatch(target), /lost acknowledgement/);
  memory.afterCommit = () => {};
  const restored = new RuntimeFleetState(memory, 4);
  assert.equal((await restored.inspect())[0]?.phase, "warming");
  await assert.rejects(restored.dispatch(target), /uncertain/);
  await restored.ready(target);
  await assert.rejects(restored.ready({ ...target, bootId: "another-boot" }), /uncertain/);
});

test("scheduling distributes held reservations across three runtimes and retains them across reconstruction", async () => {
  const memory = new SlotMemory();
  const state = new RuntimeFleetState(memory, 4);
  await ready(state, 1);
  await ready(state, 2);
  await ready(state, 3);
  const leases = await Promise.all([state.acquire(1), state.acquire(1), state.acquire(1)]);
  assert.equal(new Set(leases.map((lease) => lease.identity.instanceId)).size, 3);
  const restored = new RuntimeFleetState(memory, 4);
  assert.deepEqual(
    (await restored.inspect()).map((row) => row.active),
    [1, 1, 1],
  );
  await assert.rejects(restored.acquire(1), /capacity/);
  await leases[1]!.release();
  await leases[1]!.release();
  assert.equal((await restored.acquire(1)).identity.instanceId, "instance-2");
});

test("draining rejects delayed readiness and waits for every accepted stream before retirement", async () => {
  const memory = new SlotMemory();
  const state = new RuntimeFleetState(memory, 4);
  const target = await ready(state, 1);
  const lease = await state.acquire(2);
  assert.equal(await state.drain(target), 1);
  await assert.rejects(state.acquire(2), /capacity/);
  await assert.rejects(state.ready(target), /uncertain/);
  await assert.rejects(state.uncertain(target), /uncertain/);
  await assert.rejects(state.retired(target), /draining/);
  await lease.release();
  await state.beginRetirement(target);
  await assert.rejects(state.beginRetirement(target), /draining/);
  await state.retired(target);
  assert.equal((await state.inspect()).length, 0);
  await assert.rejects(state.reserve(target), /identity/);
  await ready(state, 2);
});

test("a lost release acknowledgement cannot free capacity twice", async () => {
  const memory = new SlotMemory();
  const state = new RuntimeFleetState(memory, 4);
  await ready(state, 1);
  const first = await state.acquire(2);
  await state.acquire(2);
  memory.afterCommit = () => {
    throw new Error("lost release acknowledgement");
  };
  await assert.rejects(first.release(), /lost release acknowledgement/);
  memory.afterCommit = () => {};
  await assert.rejects(first.release(), /lost release acknowledgement/);
  assert.equal((await state.inspect())[0]?.active, 1);
});

test("cells isolate handoff selections, share canonical policies and cannot overwrite them", async () => {
  const memory = new SlotMemory();
  const root = {
    id: { toString: () => "controller" },
    storage: Object.assign(memory, { getAlarm: async () => null, setAlarm: async () => {} }),
    container: {
      running: true,
      start: () => {
        throw new Error("must not start legacy");
      },
      destroy: async () => {},
      setInactivityTimeout: async () => {},
      getTcpPort: () => ({ fetch: async () => new Response() }),
    },
    waitUntil: () => {},
  };
  const blue = runtimeCellState(root, "blue"),
    green = runtimeCellState(root, "green");
  assert.equal(blue.container, undefined);
  assert.equal(blue.id.toString(), "controller");
  await memory.put(nativeMembershipKey, { pool: { revision: 7, dirty: true } });
  await blue.storage.put(slotSelectionKey, "blue-selection");
  await green.storage.transaction(async (transaction) => {
    await transaction.put(slotSelectionKey, "green-selection");
    assert.deepEqual(await transaction.get(nativeMembershipKey), {
      pool: { revision: 7, dirty: true },
    });
  });
  assert.equal(await blue.storage.get(slotSelectionKey), "blue-selection");
  assert.equal(await green.storage.get(slotSelectionKey), "green-selection");
  await assert.rejects(blue.storage.put(nativeMembershipKey, {}), /cannot write membership/);
  await assert.rejects(
    green.storage.transaction((transaction) => transaction.put(nativeMembershipKey, {})),
    /cannot write membership/,
  );
  assert.deepEqual(await memory.get(nativeMembershipKey), { pool: { revision: 7, dirty: true } });
});
