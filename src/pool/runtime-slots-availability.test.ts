import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, slotFixture } from "../../scripts/pool-tests/runtime-slots-fixture.ts";

const open = async (response: Promise<Response>) => {
  const reader = (await response).body!.getReader();
  const first = await reader.read();
  return { reader, boot: new TextDecoder().decode(first.value).trim() };
};

test("candidate startup failure leaves the old HTTP stream and new admissions serving", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  const old = await open(f.forward());
  f.hooks.start = async () => {
    throw new Error("candidate startup failed");
  };
  await assert.rejects(f.slots.stage(f.candidate), /startup failed/);
  assert.equal((await open(f.forward())).boot, f.old.bootId);
  f.emit(f.old.bootId, "old stream still serving");
  assert.equal(
    new TextDecoder().decode((await old.reader.read()).value),
    "old stream still serving",
  );
  assert.equal((await f.slots.inspect()).selection?.active.identity?.bootId, f.old.bootId);
  assert.equal(f.calls.retire.length, 0);
  // An uncertain start is observed without starting it again, then its exact boot can be discarded.
  assert.equal((await f.slots.observeCandidate()).bootId, f.candidate.bootId);
  assert.equal(f.calls.start.length, 1);
  assert.equal((await f.slots.discardCandidate("discard-start-failure")).status, "retired");
  assert.equal((await open(f.forward())).boot, f.old.bootId);
});

test("candidate policy400 preserves active availability and never changes selection", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  const old = await open(f.forward());
  f.hooks.install = async (identity) => {
    if (identity.instanceId === f.candidate.instanceId) throw new Error("native policy400");
  };
  await assert.rejects(f.slots.stage(f.candidate), /policy400/);
  assert.equal((await open(f.forward())).boot, f.old.bootId);
  f.emit(f.old.bootId, "still old");
  assert.equal(new TextDecoder().decode((await old.reader.read()).value), "still old");
  const intent = await f.intent();
  await assert.rejects(f.slots.promote(intent), /policy400/);
  assert.equal((await f.slots.receipt(intent.operationId))?.status, "started");
  assert.equal((await f.slots.inspect()).selection?.epoch, 1);
  assert.equal(f.calls.retire.length, 0);
});

test("promotion changes only new admissions and retires the exact old boot only after drain", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  const old = await open(f.forward());
  await f.slots.stage(f.candidate);
  const intent = await f.intent();
  const result = await f.slots.promote(intent);
  assert.equal(result.status, "promoted");
  assert.equal(result.epoch, 2);
  assert.deepEqual(result.policies, [{ pool: "pool", organization: "organization", revision: 1 }]);
  assert.equal((await open(f.forward())).boot, f.candidate.bootId);
  f.emit(f.old.bootId, "draining old");
  assert.equal(new TextDecoder().decode((await old.reader.read()).value), "draining old");
  await assert.rejects(f.slots.retireDrained("retire-too-soon"), /draining/);
  assert.equal(f.calls.retire.length, 0);
  await old.reader.cancel();
  assert.equal((await f.slots.retireDrained("retire-old")).status, "retired");
  assert.deepEqual(f.calls.retire, [f.old]);
  assert.equal((await f.slots.inspect()).selection?.draining, undefined);
  assert.deepEqual(await f.slots.promote(intent), result);
  assert.equal(f.calls.retire.length, 1);
});

test("controller reconstruction does not replace the retained active boot", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  const intent = await f.intent();
  await f.slots.promote(intent);
  const before = f.calls.start.length;
  const restarted = f.reconstruct();
  assert.equal(
    (await restarted.inspect()).selection?.active.identity?.imageInput,
    f.candidate.imageInput,
  );
  assert.equal((await open(f.forward())).boot, f.candidate.bootId);
  assert.equal(f.calls.start.length, before);
  assert.equal(f.calls.retire.length, 0);
  assert.equal((await restarted.promote(intent)).status, "promoted");
});

test("requests racing promotion register their old slot before it becomes draining", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  const healthEntered = deferred(),
    healthRelease = deferred();
  f.hooks.health = async (identity) => {
    if (identity.instanceId !== f.old.instanceId) return;
    healthEntered.resolve();
    await healthRelease.promise;
  };
  const request = f.forward();
  await healthEntered.promise;
  await f.slots.promote(await f.intent());
  await assert.rejects(f.slots.retireDrained("retire-racing-request"), /draining/);
  healthRelease.resolve();
  const response = await open(request);
  assert.equal(response.boot, f.old.bootId);
  await response.reader.cancel();
  assert.equal((await f.slots.retireDrained("retire-after-response")).status, "retired");
});
