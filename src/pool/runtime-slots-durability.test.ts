import assert from "node:assert/strict";
import { test } from "node:test";
import { slotFixture, slotIdentity } from "../../scripts/pool-tests/runtime-slots-fixture.ts";
import { RuntimeSlots } from "./runtime-slots/controller.ts";
import { nativeMembershipKey, slotSelectionKey } from "./runtime-slots/storage.ts";
import type { NativeMembershipPolicy } from "./membership-contract.ts";
import type { PromotionReceipt, SlotSelection } from "./runtime-slots/contract.ts";

test("lost promotion replies inspect the atomic selection and receipt without repeating proof", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  const intent = await f.intent();
  let lost = false;
  f.memory.afterCommit = (draft) => {
    const receipt = draft.get(f.storage.receiptKey(intent.operationId)) as
      | PromotionReceipt
      | undefined;
    if (lost || receipt?.status !== "promoted") return;
    lost = true;
    f.memory.readsFailed = true;
    throw new Error("lost transaction reply");
  };
  await assert.rejects(f.slots.promote(intent), /read unavailable/);
  f.memory.readsFailed = false;
  const installed = f.calls.install.length,
    restarted = f.reconstruct();
  assert.equal((await restarted.inspect()).selection?.active.identity?.bootId, f.candidate.bootId);
  assert.equal((await restarted.receipt(intent.operationId))?.status, "promoted");
  assert.equal((await restarted.promote(intent)).status, "promoted");
  assert.equal(f.calls.install.length, installed);
  assert.equal(f.calls.start.length, 1);
});

test("a failed atomic commit keeps the old selection and the started attempt inspection-only", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  const intent = await f.intent();
  f.memory.beforeCommit = (draft) => {
    if ((draft.get(slotSelectionKey) as SlotSelection).epoch === 2)
      throw new Error("commit refused");
  };
  await assert.rejects(f.slots.promote(intent), /commit refused/);
  const installed = f.calls.install.length;
  f.memory.beforeCommit = () => {};
  const restarted = f.reconstruct();
  assert.equal((await restarted.inspect()).selection?.active.identity?.bootId, f.old.bootId);
  assert.equal((await restarted.receipt(intent.operationId))?.status, "started");
  assert.equal((await restarted.promote(intent)).status, "started");
  assert.equal(f.calls.install.length, installed);
  assert.equal((await restarted.inspect()).selection?.epoch, 1);
});

test("policy accounts, selection epoch and candidate boot drift each refuse promotion", async (context) => {
  for (const drift of ["accounts", "epoch", "boot"] as const) {
    const f = await slotFixture();
    context.after(f.cleanup);
    await f.slots.stage(f.candidate);
    const intent = await f.intent();
    if (drift === "accounts")
      await f.memory.transaction(async (transaction) => {
        const rows =
          await transaction.get<Record<string, NativeMembershipPolicy>>(nativeMembershipKey);
        await transaction.put(nativeMembershipKey, {
          ...rows,
          pool: { ...rows!.pool, accounts: ["changed"] },
        });
      });
    if (drift === "epoch")
      await f.memory.transaction(async (transaction) => {
        const state = await transaction.get<SlotSelection>(slotSelectionKey);
        await transaction.put(slotSelectionKey, { ...state, epoch: 3 });
      });
    if (drift === "boot")
      f.runtimes.set(f.candidate.instanceId, { ...f.candidate, bootId: "other-boot" });
    await assert.rejects(f.slots.promote(intent));
    assert.equal((await f.slots.inspect()).selection?.active.identity?.bootId, f.old.bootId);
    assert.equal(f.calls.retire.length, 0);
  }
});

test("TTL renewal cannot disguise expiry of the candidate's actual policy acknowledgement", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  let now = Date.now();
  const slots = new RuntimeSlots({
    controllerId: f.old.controllerId,
    controllerCode: f.controllerCode,
    storage: f.storage,
    driver: f.driver,
    streams: f.streams,
    clock: { now: () => now, monotonic: () => performance.now() },
  });
  const before = await f.storage.inspect(),
    intent = await f.intent();
  f.hooks.install = async () => {
    now = before.policies[0]!.expiresAt + 1;
    await f.memory.transaction(async (transaction) => {
      const rows =
        await transaction.get<Record<string, NativeMembershipPolicy>>(nativeMembershipKey);
      await transaction.put(nativeMembershipKey, {
        ...rows,
        pool: { ...rows!.pool, expiresAt: now + 15_000 },
      });
    });
  };
  assert.equal((await slots.promote(intent)).status, "refused");
  assert.equal((await slots.inspect()).selection?.active.identity?.bootId, f.old.bootId);
});

test("unknown retirement stays durable and never destroys the exact old boot twice", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  await f.slots.promote(await f.intent());
  f.memory.beforeCommit = (draft) => {
    if (!(draft.get(slotSelectionKey) as SlotSelection).draining)
      throw new Error("lost retirement commit");
  };
  await assert.rejects(f.slots.retireDrained("retirement-unknown"), /lost retirement commit/);
  assert.deepEqual(f.calls.retire, [f.old]);
  assert.equal(f.runtimes.has(f.old.instanceId), false);
  f.memory.beforeCommit = () => {};
  const restarted = f.reconstruct();
  assert.equal((await restarted.retirement.inspect("retirement-unknown"))?.status, "started");
  assert.equal((await restarted.retireDrained("retirement-unknown")).status, "started");
  assert.equal(f.calls.retire.length, 1);
  assert.equal((await restarted.inspect()).selection?.draining?.fenced, true);
});

test("a third runtime cannot be staged while the old slot is draining", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  await f.slots.promote(await f.intent());
  await assert.rejects(f.slots.stage(slotIdentity("third")), /selection/);
  assert.equal(f.calls.start.length, 1);
  assert.equal((await f.slots.inspect()).selection?.draining?.identity?.bootId, f.old.bootId);
});

test("retirement needs positive endpoint drain before committing its irreversible intent", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  await f.slots.promote(await f.intent());
  let active = 1;
  let known = true;
  f.driver.drain = async () => ({ active, known });
  const reconstructed = f.reconstruct();
  await assert.rejects(reconstructed.retireDrained("endpoint-drain"), /draining/);
  assert.equal(await reconstructed.retirement.inspect("endpoint-drain"), undefined);
  assert.equal(f.calls.retire.length, 0);
  active = 0;
  known = false;
  await assert.rejects(reconstructed.retireDrained("endpoint-drain"), /draining/);
  assert.equal(await reconstructed.retirement.inspect("endpoint-drain"), undefined);
  known = true;
  assert.equal((await reconstructed.retireDrained("endpoint-drain")).status, "retired");
  assert.equal(f.calls.retire.length, 1);
});
