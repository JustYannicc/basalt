import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";

test(
  "a long cold start renews expired authority before recovery becomes ready",
  { timeout: 15_000 },
  async (context) => {
    let now = Date.now(),
      advanced = false;
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    f.old.hooks.health = async () => {
      if (f.old.calls.start && !advanced) {
        advanced = true;
        now += 180_000;
      }
    };
    f.old.crash();
    await f.upkeep();
    await f.settle();
    assert.equal(advanced, true);
    assert.equal(f.old.calls.start, 1);
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.ok(f.old.calls.install.some((policy) => !policy.dirty && policy.expiresAt > now));
  },
);

test(
  "missing provider credentials cannot restart compute and a later valid observation recovers automatically",
  { timeout: 10_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    f.old.crash();
    f.secretAvailable(false);
    await f.upkeep();
    await f.settle();
    assert.equal(f.old.calls.start, 0);
    f.secretAvailable(true);
    await f.upkeep();
    await f.settle();
    assert.equal(f.old.calls.start, 1);
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
  },
);

test(
  "a proved stopped unacknowledged restart uses the checked ledger generation on its next alarm",
  { timeout: 10_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    const start = f.old.ctx.container.start.bind(f.old.ctx.container);
    let fail = true;
    f.old.ctx.container.start = (options) => {
      start(options);
      if (fail) {
        fail = false;
        f.old.crash();
        throw new Error("synthetic startup crash before acknowledgment");
      }
    };
    f.old.crash();
    await f.upkeep();
    await f.settle();
    assert.equal(f.old.calls.start, 1);
    assert.equal(f.old.ctx.container.running, false);
    f.reconstruct();
    await f.upkeep();
    await f.settle();
    assert.equal(f.old.calls.start, 2);
    assert.equal(f.old.ctx.container.running, true);
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
  },
);

test(
  "a fence committed during cold startup prevents recovery from restoring routing",
  { timeout: 10_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    const entered = deferred(),
      release = deferred();
    context.after(async () => {
      release.resolve();
      await f.cleanup();
    });
    await f.bootstrap();
    const before = await f.inspect();
    f.old.hooks.health = async () => {
      if (f.old.calls.start) {
        entered.resolve();
        await release.promise;
      }
    };
    f.old.crash();
    await f.upkeep();
    await entered.promise;
    assert.equal(
      (await f.command("fence", { identity: before.selection.active.identity })).status,
      200,
    );
    release.resolve();
    await f.settle();
    const after = await f.inspect();
    assert.equal(after.selection.active.fenced, true);
    assert.equal(after.selection.epoch, before.selection.epoch);
    assert.equal(after.selection.active.identity?.bootId, before.selection.active.identity?.bootId);
    const response = await f.model();
    assert.equal(response.status, 503);
  },
);
