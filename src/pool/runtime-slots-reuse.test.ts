import assert from "node:assert/strict";
import { test } from "node:test";
import { slotFixture } from "../../scripts/pool-tests/runtime-slots-fixture.ts";

test("two promotions can reuse a logical slot without the retired boot's watcher aborting its new streams", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  const first = (await f.forward()).body!.getReader();
  await first.read();
  await first.cancel();
  await f.slots.stage(f.candidate);
  await f.slots.promote(await f.intent());
  await f.slots.retireDrained("retire-first-a");
  const drainingB = (await f.forward()).body!.getReader();
  await drainingB.read();
  const next = {
    ...f.old,
    applicationVersion: "2",
    imageDigest: `sha256:${"c".repeat(64)}`,
    imageInput: "second-a-image",
    bootId: "second-a-boot",
  };
  f.runtimes.set(next.instanceId, next);
  await f.slots.stage(next);
  const snapshot = await f.slots.inspect();
  assert.equal(
    (
      await f.slots.promote({
        operationId: crypto.randomUUID(),
        expectedEpoch: 2,
        controllerCode: f.controllerCode,
        previous: f.candidate,
        candidate: next,
        policyDigest: snapshot.digest,
      })
    ).status,
    "promoted",
  );
  const current = (await f.forward()).body!.getReader();
  assert.equal(new TextDecoder().decode((await current.read()).value).trim(), next.bootId);
  await f.background[0];
  f.emit(next.bootId, "new A still serving");
  assert.equal(new TextDecoder().decode((await current.read()).value), "new A still serving");
  f.emit(f.candidate.bootId, "B still draining");
  assert.equal(new TextDecoder().decode((await drainingB.read()).value), "B still draining");
  await assert.rejects(f.slots.retireDrained("retire-live-b"), /draining/);
  await drainingB.cancel();
  assert.equal((await f.slots.retireDrained("retire-b")).status, "retired");
  assert.equal(f.calls.retire.length, 2);
});

test("controller code is separate from stable routing and an old code promotion intent refuses", async (context) => {
  const f = await slotFixture();
  context.after(f.cleanup);
  await f.slots.stage(f.candidate);
  const oldIntent = await f.intent();
  const code = { candidate: "b".repeat(40), workerInput: "2".repeat(64) };
  const updated = f.reconstruct(code);
  assert.deepEqual((await updated.inspect()).controllerCode, code);
  assert.equal((await updated.inspect()).selection?.active.identity?.bootId, f.old.bootId);
  await assert.rejects(updated.promote(oldIntent), /identity/);
  assert.equal(await updated.receipt(oldIntent.operationId), undefined);
  const old = (await f.forward()).body!.getReader();
  assert.equal(new TextDecoder().decode((await old.read()).value).trim(), f.old.bootId);
  const result = await updated.promote(await f.intent());
  assert.equal(result.status, "promoted");
  assert.deepEqual(result.intent.controllerCode, code);
});
