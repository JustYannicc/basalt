import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";

test(
  "selected runtime recovery restarts stopped compute without an operator",
  { timeout: 10_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "automatic-recovery-proof",
      configuration: f.configuration,
    });
    const before = f.old.identity();
    f.old.crash();
    await f.upkeep();
    await f.settle();
    assert.equal(
      f.old.ctx.container.running,
      true,
      "selected runtime must recover during automatic upkeep",
    );
    assert.notEqual(f.old.identity().bootId, before.bootId);
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
  },
);

test(
  "idle selected crash is repaired before a later request and survives controller reconstruction",
  { timeout: 10_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    const previous = f.old.identity();
    f.old.crash();
    f.reconstruct();
    const detected = now;
    await f.upkeep();
    await f.settle();
    assert.equal(f.old.ctx.container.running, true);
    assert.notEqual(f.old.identity().bootId, previous.bootId);
    assert.equal(f.old.calls.start, 1);
    now = detected + 204_001;
    // Deliver the due Home alarm too: native membership renewals remain independent of recovery.
    await f.alarm();
    await f.settle();
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal(f.old.calls.start, 1, "arrival after recovery must not cause a cold start");
  },
);

test(
  "concurrent reads and undispatched model calls cross selected stop without client errors or duplicate execution",
  { timeout: 15_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "concurrent-recovery",
      configuration: { ...f.configuration, targetActive: 100 },
    });
    const attempts = new Map<string, number>();
    f.onModel(async (_instance, request) => {
      const id = new URL(request.url).searchParams.get("proof")!;
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      return new Response(`ok:${id}`);
    });
    f.old.crash();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        f.model(
          new Request(
            `http://pool/v1/${i % 2 ? "responses" : "models"}?proof=${i}`,
            i % 2
              ? {
                  method: "POST",
                  body: JSON.stringify({ model: "synthetic", input: "test" }),
                  headers: { "content-type": "application/json" },
                }
              : {},
          ),
        ),
      ),
    );
    for (const [i, response] of responses.entries()) {
      assert.equal(response.status, 200, `client ${i}`);
      assert.equal(await response.text(), `ok:${i}`);
      assert.equal(attempts.get(String(i)), 1);
    }
    await f.settle();
    assert.equal(f.old.calls.start, 1);
  },
);

test(
  "a lost restart reply joins its persisted launch after reconstruction",
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
        throw new Error("synthetic lost start reply");
      }
    };
    f.old.crash();
    await f.upkeep();
    await f.settle();
    assert.equal(f.old.calls.start, 1);
    f.reconstruct();
    await f.upkeep();
    await f.settle();
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal(
      f.old.calls.start,
      1,
      "reconstruction must observe, never dispatch a second start",
    );
  },
);

test(
  "an accepted interrupted call is not replayed and receives native HTTP retry advice",
  { timeout: 10_000 },
  async (context) => {
    const errors = context.mock.method(console, "error", () => {});
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    let attempts = 0;
    f.onModel(async (instance) => {
      attempts++;
      instance.crash();
      throw new Error("synthetic accepted runtime crash");
    });
    for (const [path, status, type] of [
      ["responses", 503, "server_error"],
      ["messages", 503, "api_error"],
    ] as const) {
      const response = await f.model(
        new Request(`http://pool/v1/${path}`, {
          method: "POST",
          body: JSON.stringify({ model: "synthetic", input: "test" }),
          headers: { "content-type": "application/json" },
        }),
      );
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), "1");
      const body = (await response.json()) as { error: { type: string } };
      assert.equal(body.error.type, type);
      const requestId = response.headers.get("X-Request-Id");
      assert.equal(
        errors.mock.calls
          .filter((call) => call.arguments[0] === "POOL_RUNTIME_ROUTE_FAILURE")
          .at(-1)!.arguments[1].requestId,
        requestId,
      );
      await f.upkeep();
    }
    assert.equal(attempts, 2, "one attempt per accepted original");
    f.onModel(async () => new Response("client retry succeeded"));
    const response = await f.model(
      new Request("http://pool/v1/responses", { method: "POST", body: "{}" }),
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "client retry succeeded");
  },
);

test(
  "recent traffic retains one warm sibling across reconstruction and retires it after the grace",
  { timeout: 15_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "recent-demand",
      configuration: { ...f.configuration, targetActive: 100 },
    });
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
    await f.settle();
    const state = new RuntimeFleetState(f.old.storage, 4);
    const [first] = await f.resourcesWhen(
      (rows) => rows.length === 1 && rows[0]?.phase === "ready",
    );
    assert.ok(first?.identity);
    f.reconstruct();
    now += 59_000;
    await f.upkeep();
    await f.settle();
    assert.equal((await state.inspect())[0]?.phase, "ready");
    now += 1_001;
    await f.upkeep();
    await f.settle();
    assert.equal((await state.inspect())[0]?.phase, "draining");
    await f.upkeep();
    await f.settle();
    assert.deepEqual(await state.inspect(), []);
  },
);

test(
  "a healthy warm sibling serves while selected cold readiness is blocked",
  { timeout: 15_000 },
  async (context) => {
    const f = await fleetWorkerFixture();
    const entered = deferred(),
      release = deferred();
    context.after(async () => {
      release.resolve();
      await f.cleanup();
    });
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "warm-failover",
      configuration: { ...f.configuration, targetActive: 100 },
    });
    f.onModel(
      async (instance) =>
        new Response("served", { headers: { "x-fixture-runtime": instance.target.instanceId } }),
    );
    const first = await f.model();
    await first.body?.cancel();
    await f.settle();
    const [sibling] = await f.resourcesWhen((rows) => rows.some((row) => row.phase === "ready"));
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
    const response = await f.model();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fixture-runtime"), sibling!.target.instanceId);
    assert.equal(await response.text(), "served");
    assert.equal(f.old.calls.start, 1);
    assert.equal(
      (await f.inspect()).selection.epoch,
      before.selection.epoch,
      "healthy failover must not wait for selected readiness or promotion",
    );
    release.resolve();
    await f.settle();
    assert.equal(f.old.calls.start, 1);
  },
);

test(
  "periodic supervision replaces a stopped sibling without a discovering model request",
  { timeout: 15_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "proactive-extra",
      configuration: { ...f.configuration, targetActive: 100 },
    });
    let calls = 0;
    f.onModel(async () => {
      calls++;
      return new Response("served");
    });
    const response = await f.model();
    await response.body?.cancel();
    await f.settle();
    const [previous] = await f.resourcesWhen((rows) => rows.some((row) => row.phase === "ready"));
    const dead = f.instances.get(previous!.target.instanceId)!;
    // Settle the membership pass first, so the fleet's own health reads decide.
    await f.upkeep();
    await f.settle();
    dead.fixture.crash();
    // The first failed read only fences the stopped cell; one 6 s later quarantines it.
    await f.upkeep();
    await f.settle();
    now += 6_000;
    await f.upkeep();
    await f.settle();
    const ended = (await f.send("fleet-inspect")) as {
      recentEnds?: { slotId: string; failure?: { rule?: string } }[];
      resources: { target: { slotId: string }; failure?: { rule?: string } }[];
    };
    const record =
      ended.resources.find((row) => row.target.slotId === previous!.target.slotId)?.failure ??
      ended.recentEnds?.find((entry) => entry.slotId === previous!.target.slotId)?.failure;
    assert.equal(record?.rule, "failed_twice", JSON.stringify(record));
    const next = await f.resourcesWhen(
      (rows) =>
        rows.length === 1 &&
        rows[0]?.phase === "ready" &&
        rows[0].target.instanceId !== previous!.target.instanceId,
    );
    assert.equal(calls, 1);
    assert.notEqual(next[0]?.target.instanceId, previous!.target.instanceId);
    assert.equal(
      dead.fixture.calls.destroy,
      0,
      "proved stopped compute does not require destruction",
    );
  },
);

test(
  "the controller inspect shows the root's last recovery: detected, ready, its rounds and the failed round's refusal",
  { timeout: 20_000 },
  async (context) => {
    for (const level of ["info", "warn", "error"] as const)
      context.mock.method(console, level, () => {});
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    const previous = f.old.identity();
    f.old.ctx.container.signal(9);
    await f.settle();
    const killedAt = now;
    // The first restart's container ends before it ever answers ready.
    let failed = false;
    f.old.hooks.health = async () => {
      if (failed) return;
      failed = true;
      f.old.ctx.container.signal(9);
      return new Response(null, { status: 503 });
    };
    for (let pass = 0; pass < 4; pass++) {
      await f.upkeep();
      await f.settle();
      now += 5_000;
    }
    const { lastRecovery } = (await f.send("inspect")) as {
      lastRecovery: {
        boot: string;
        detectedAt: number;
        readyAt: number | null;
        rounds: number;
        refusals: { round: number; reason: string; class: string }[];
      } | null;
    };
    assert.ok(failed, "the first restart attempt ended");
    assert.equal(lastRecovery?.boot, previous.bootId);
    assert.equal(lastRecovery?.detectedAt, killedAt);
    // Ready when the second round's restart served, one pass after the first round failed.
    assert.equal(lastRecovery?.readyAt, killedAt + 5_000);
    assert.equal(lastRecovery?.rounds, 2);
    assert.deepEqual(
      lastRecovery?.refusals.map((refusal) => refusal.round),
      [1],
    );
    // The next healthy passes leave it as it is.
    await f.upkeep();
    await f.settle();
    assert.deepEqual(((await f.send("inspect")) as { lastRecovery: unknown }).lastRecovery, lastRecovery);
  },
);
