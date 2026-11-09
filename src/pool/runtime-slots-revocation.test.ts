import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, slotFixture } from "../../scripts/pool-tests/runtime-slots-fixture.ts";

test("signed dirty reservation aborts old streams before a candidate policy400 can fail the writer", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  const old = (await f.forward()).body!.getReader();
  await old.read();
  await f.slots.stage(f.candidate);
  const abortObserved = old.read().then(
    () => assert.fail("revoked stream remained readable"),
    () => {},
  );
  f.hooks.install = async (identity, policy) => {
    if (identity.instanceId !== f.candidate.instanceId || !policy.dirty) return;
    assert.ok(f.streamsClosed.includes(f.old.bootId), "streams abort before the fallible fanout");
    throw new Error("candidate native policy400");
  };
  await assert.rejects(f.reserve());
  await abortObserved;
  await assert.rejects(f.forward(), /authority|refreshing/);
  assert.equal(f.policies.get(f.old.instanceId)?.get("pool")?.dirty, true);
  assert.equal(f.policies.get(f.candidate.instanceId)?.get("pool")?.dirty, false);
  await f.slots.fence(f.candidate);
  assert.equal((await f.slots.inspect()).selection?.candidate?.fenced, true);
  // Once the unreachable candidate is durably fenced, a fresh signed writer can confirm enforcement.
  await f.reserve();
  assert.equal((await f.slots.inspect()).selection?.active.identity?.bootId, f.old.bootId);
  await assert.rejects(f.slots.promote(await f.intent()), /selection|policy/);
  f.hooks.install = async () => {};
  await f.memberships.refresh("pool");
  await f.slots.unfence(f.candidate);
  assert.equal((await f.slots.inspect()).selection?.candidate?.fenced, false);
  const response = await f.forward();
  assert.equal(response.status, 200);
});

test("active and draining streams both abort before signed revocation acknowledgement", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  const old = (await f.forward()).body!.getReader();
  await old.read();
  await f.slots.stage(f.candidate);
  await f.slots.promote(await f.intent());
  const current = (await f.forward()).body!.getReader();
  await current.read();
  const done = [old, current].map((reader) =>
    reader.read().then(
      () => assert.fail("revoked stream survived"),
      () => {},
    ),
  );
  await f.reserve();
  await Promise.all(done);
  assert.deepEqual(new Set(f.streamsClosed), new Set([f.old.bootId, f.candidate.bootId]));
  for (const identity of [f.old, f.candidate])
    assert.equal(f.policies.get(identity.instanceId)?.get("pool")?.dirty, true);
  await assert.rejects(f.forward());
});

test("admission paused after clean authority cannot miss revocation while the dirty install fails", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  const signing = deferred(),
    release = deferred();
  f.hooks.authorize = async () => {
    signing.resolve();
    await release.promise;
  };
  const pending = f.forward();
  await signing.promise;
  f.hooks.install = async (_identity, policy) => {
    if (policy.dirty) throw new Error("policy400");
  };
  await assert.rejects(f.reserve());
  const previousDispatches = f.calls.fetch.length;
  release.resolve();
  await assert.rejects(pending);
  assert.equal(f.calls.fetch.length, previousDispatches);
});

test("a revocation during candidate proof invalidates promotion even if old clean ACKs were collected", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  const entered = deferred(),
    release = deferred();
  f.hooks.install = async (identity, policy) => {
    if (identity.instanceId === f.candidate.instanceId && !policy.dirty) {
      entered.resolve();
      await release.promise;
    }
  };
  const intent = await f.intent(),
    promoting = f.slots.promote(intent);
  await entered.promise;
  await f.reserve();
  release.resolve();
  assert.equal((await promoting).status, "refused");
  assert.equal((await f.slots.inspect()).selection?.active.identity?.bootId, f.old.bootId);
  assert.equal((await f.slots.inspect()).selection?.epoch, 1);
  assert.equal(f.policies.get(f.candidate.instanceId)?.get("pool")?.dirty, true);
  await assert.rejects(f.forward());
});

test("an unobserved candidate prevents a success ACK and passive observation never starts it twice", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  f.hooks.start = async () => {
    throw new Error("lost startup reply");
  };
  await assert.rejects(f.slots.stage(f.candidate));
  await assert.rejects(f.reserve());
  await assert.rejects(f.slots.discardCandidate("unknown-boot"), /uncertain/);
  await f.slots.observeCandidate();
  await f.slots.fence(f.candidate);
  await f.reserve();
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.calls.retire.length, 0);
});
