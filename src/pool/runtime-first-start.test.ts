import assert from "node:assert/strict";
import { test } from "node:test";
import { slotFixture } from "../../scripts/pool-tests/runtime-slots-fixture.ts";
import { slotSelectionKey, nativeMembershipKey } from "./runtime-slots/storage.ts";
import type { NativeMembershipPolicy } from "./membership-contract.ts";

async function fixture() {
  const f = await slotFixture();
  f.memory.values.delete(slotSelectionKey);
  await f.memory.transaction(async (transaction) => {
    const rows = await transaction.get<Record<string, NativeMembershipPolicy>>(nativeMembershipKey);
    await transaction.put(nativeMembershipKey, {
      ...rows,
      retired: {
        ...rows!.pool,
        pool: "retired",
        accounts: [],
        dirty: true,
        retired: { resumeAfter: Date.now() + 15_000 },
      },
    });
  });
  const candidate = { ...f.candidate, homePeerOrdinal: 1 };
  f.runtimes.set(candidate.instanceId, candidate);
  return { ...f, candidate };
}

test("first start remains unselected until a fresh proof installs every required policy", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { digest } = await f.storage.inspect();
  const identity = await f.slots.firstStart.start(f.candidate, digest);
  assert.equal((await f.slots.inspect()).selection, undefined);
  assert.equal(f.calls.start.length, 1);
  let verified = false;
  await f.slots.firstStart.activate(identity, digest, () => {
    verified = true;
  });
  assert.equal(verified, true);
  assert.equal((await f.slots.inspect()).selection?.active.identity?.bootId, identity.bootId);
  assert.equal(f.policies.get(identity.instanceId)?.get("pool")?.dirty, false);
  assert.equal(f.policies.get(identity.instanceId)?.get("retired")?.dirty, true);
  await assert.rejects(f.slots.firstStart.start(f.candidate, digest), /uncertain/);
  assert.equal(f.calls.start.length, 1);
});

test("an uncertain first start is recovered only by observation after reconstruction", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  f.hooks.start = async () => {
    throw new Error("lost start response");
  };
  const { digest } = await f.storage.inspect();
  await assert.rejects(f.slots.firstStart.start(f.candidate, digest), /lost start/);
  const reconstructed = f.reconstruct();
  await assert.rejects(reconstructed.firstStart.start(f.candidate, digest), /uncertain/);
  assert.equal(f.calls.start.length, 1);
  const identity = await reconstructed.firstStart.observe();
  await reconstructed.firstStart.activate(identity, digest, () => {});
  assert.equal((await reconstructed.inspect()).selection?.active.identity?.bootId, identity.bootId);
  assert.equal(f.calls.start.length, 1);
});

test("a lost durable first-start registration cannot dispatch or retry a start", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { digest } = await f.storage.inspect();
  f.memory.afterCommit = () => {
    throw new Error("lost registration reply");
  };
  await assert.rejects(f.slots.firstStart.start(f.candidate, digest), /lost registration/);
  assert.equal(f.calls.start.length, 0);
  f.memory.afterCommit = () => {};
  await assert.rejects(f.reconstruct().firstStart.start(f.candidate, digest), /uncertain/);
  assert.equal(f.calls.start.length, 0);
  assert.equal((await f.slots.inspect()).selection, undefined);
});

test("a policy change during first activation leaves the new cell unavailable", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const { digest } = await f.storage.inspect();
  const identity = await f.slots.firstStart.start(f.candidate, digest);
  f.hooks.install = async () => {
    await f.memory.transaction(async (transaction) => {
      const rows =
        await transaction.get<Record<string, NativeMembershipPolicy>>(nativeMembershipKey);
      await transaction.put(nativeMembershipKey, {
        ...rows,
        pool: { ...rows!.pool, revision: 2, dirty: true },
      });
    });
  };
  await assert.rejects(
    f.slots.firstStart.activate(identity, digest, () => {}),
    /selection/,
  );
  assert.equal((await f.slots.inspect()).selection, undefined);
  assert.equal(f.calls.retire.length, 0);
});
