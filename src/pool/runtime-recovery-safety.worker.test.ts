import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
const runtimeModule = "./runtime.worker.ts";
const {
  createPoolLifecycle,
}: { createPoolLifecycle(ctx: object, env: object): Promise<{ warm(): Promise<unknown> }> } =
  await import(runtimeModule);

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

test(
  "a crash during post-boot completion recovers again after reconstruction",
  { timeout: 10_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    let crashed = false;
    f.old.hooks.health = async () => {
      if (
        f.old.calls.start === 1 &&
        !crashed &&
        (await f.inspect()).selection.active.identity?.bootId === f.old.identity().bootId
      ) {
        crashed = true;
        f.old.crash();
        throw new Error("synthetic completion crash");
      }
    };
    f.old.crash();
    await f.upkeep();
    await f.settle();
    assert.equal(crashed, true);
    assert.equal(f.old.calls.start, 1);
    f.reconstruct();
    await f.upkeep();
    await f.settle();
    assert.equal(f.old.calls.start, 2);
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
  },
);

test(
  "a later successful alarm clears an earlier failed primary recovery without reconstruction",
  { timeout: 15_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "failed-primary-recovery",
      configuration: { ...f.configuration, maximum: 1, targetActive: 100 },
    });
    let crashed = false;
    f.onModel(async (instance) => {
      if (!crashed) {
        crashed = true;
        instance.crash();
        throw new Error("synthetic accepted crash");
      }
      return new Response("healthy", {
        headers: { "x-proof-runtime": instance.target.instanceId },
      });
    });
    f.secretAvailable(false);
    assert.equal(
      (await f.model(new Request("http://pool/v1/responses", { method: "POST", body: "{}" })))
        .status,
      503,
    );
    await f.settle();
    f.secretAvailable(true);
    await f.upkeep();
    await f.settle();
    const response = await f.model();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-proof-runtime"), f.old.target.instanceId);
    assert.equal(await response.text(), "healthy");
  },
);

test(
  "an accepted legacy call is never replayed by the recovery adapter",
  { timeout: 10_000 },
  async (context) => {
    const f = await handoffWorker({
      adopt: false,
      bindings: { PoolRuntime: undefined, POOL_RUNTIME_APPLICATION_ID: undefined },
    });
    context.after(f.cleanup);
    await (await createPoolLifecycle(f.old.ctx, f.old.env)).warm();
    let calls = 0;
    f.old.hooks.model = async () => {
      calls++;
      throw new Error("synthetic accepted legacy reply loss");
    };
    const response = await f.model(
      new Request("http://pool/v1/responses", { method: "POST", body: "{}" }),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    await response.body?.cancel();
    assert.equal(calls, 1);
  },
);
