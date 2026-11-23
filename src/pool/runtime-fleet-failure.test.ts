import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { failureFleetFixture as fixture } from "../../scripts/pool-tests/runtime-fleet-failure-fixture.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { rememberRuntimeFailure } from "./runtime-route-diagnostic.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";

test("a health refusal fences the exact runtime before eleven new requests and survives reconstruction", async () => {
  const f = await fixture(),
    dead = await f.add(),
    sibling = await f.add();
  let attempts = 0;
  f.cell(dead).forward = async () => {
    attempts++;
    const error = new SlotRefused("unhealthy");
    rememberRuntimeFailure("slot_health", error);
    throw error;
  };
  await assert.rejects(f.forward(), /unhealthy/);
  // A refusal before the send is one health sample: the runtime is fenced, not yet quarantined.
  const fenced = (await f.state.inspect()).find((row) => row.target.slotId === dead.slotId);
  assert.equal(fenced?.phase, "ready");
  assert.ok(fenced?.suspect, "the refused runtime is not fenced in its durable row");
  const reconstructed = f.createFleet();
  for (let index = 0; index < 11; index++)
    assert.equal(await (await f.forward(undefined, reconstructed)).text(), "terminal");
  await f.settle();
  assert.equal(attempts, 1);
  assert.equal(f.legacyCalls(), 0);
  assert.deepEqual(new Set(f.sends), new Set([sibling.instanceId]));
});

test("recent demand protects a surviving idle sibling when the first ready sibling fails its probe", async (context) => {
  let now = 0;
  context.mock.method(Date, "now", () => now);
  const f = await fixture(),
    dead = await f.add(),
    healthy = await f.add();
  now = 60_001;
  const pending: Promise<unknown>[] = [];
  const fleet = new RuntimeFleet({
    state: f.state,
    target: async () => assert.fail("unreclaimed failed compute still owns physical capacity"),
    cell: (target) => ({
      ...f.cell(target),
      healthy: async () => {
        if (target.slotId === dead.slotId) throw new SlotRefused("unhealthy");
      },
    }),
    legacyActive: async () => 0,
    currentRequests: () => 0,
    targetActive: 10,
    idleMilliseconds: 60_000,
    maximum: 2,
    now: () => now,
    recentDemandUntil: async () => 120_000,
    wrap: (response) => response,
    defer: (work) => {
      pending.push(work);
    },
  });
  // The first failed read fences the sibling; a second one 6 s later quarantines it.
  for (let pass = 0; pass < 2; pass++) {
    await fleet.upkeep();
    await Promise.all(pending);
    now += 6_000;
  }
  const rows = await f.state.inspect();
  assert.equal(rows.find((row) => row.target.slotId === dead.slotId)?.phase, "quarantined");
  assert.equal(rows.find((row) => row.target.slotId === healthy.slotId)?.phase, "ready");
});

test("a lost dispatched reply quarantines without replaying the invocation", async () => {
  const f = await fixture(),
    dead = await f.add();
  f.cell(dead).forward = async (_request, _port, _pool, before) => {
    before();
    f.sends.push(dead.instanceId);
    throw new Error("lost upstream reply");
  };
  await assert.rejects(f.forward(), /lost upstream reply/);
  assert.equal((await f.state.inspect())[0]?.phase, "quarantined");
  assert.deepEqual(f.sends, [dead.instanceId]);
  assert.equal(f.legacyCalls(), 0);
});

test("a body transport failure fences before releasing the failed stream while a sibling finishes", async () => {
  const f = await fixture(),
    dead = await f.add(),
    sibling = await f.add();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  f.cell(dead).forward = async (_request, _port, _pool, before) => {
    before();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
    );
  };
  const failed = await f.forward(),
    siblingResponse = await f.forward();
  const reading = failed.text();
  body.error(new Error("runtime connection lost"));
  await assert.rejects(reading, /runtime connection lost/);
  assert.equal(
    (await f.state.inspect()).find((row) => row.target.slotId === dead.slotId)?.phase,
    "quarantined",
  );
  assert.equal(await siblingResponse.text(), "terminal");
  assert.equal(await (await f.forward()).text(), "terminal");
  await f.settle();
  assert.deepEqual(new Set(f.sends), new Set([sibling.instanceId]));
});

test("caller cancellation, policy refusal and provider HTTP errors do not quarantine a runtime", async () => {
  const f = await fixture(),
    identity = await f.add(),
    cell = f.cell(identity);
  const abort = new AbortController();
  cell.forward = async () => {
    abort.abort();
    throw abort.signal.reason;
  };
  await assert.rejects(f.forward(abort.signal));
  cell.forward = async () => {
    const error = new SlotRefused("policy");
    rememberRuntimeFailure("slot_authorize", error);
    throw error;
  };
  await assert.rejects(f.forward(), /policy/);
  cell.forward = async () => new Response("provider unavailable", { status: 503 });
  const response = await f.forward();
  assert.equal(response.status, 503);
  await response.text();
  await f.settle();
  assert.equal((await f.state.inspect())[0]?.phase, "ready");
});

test("quarantine holds the physical limit until stopped absence, then replenishes with a fresh identity", async () => {
  const f = await fixture(1),
    dead = await f.add();
  f.cell(dead).forward = async () => {
    throw new Error("runtime transport failed");
  };
  await assert.rejects(f.forward(), /runtime transport failed/);
  await f.settle();
  await f.fleet.upkeep();
  await f.settle();
  assert.equal((await f.state.inspect()).length, 1);
  assert.equal((await f.state.inspect())[0]?.phase, "quarantined");
  f.stop();
  await f.fleet.upkeep();
  await f.settle();
  const rows = await f.state.inspect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.phase, "ready");
  assert.notEqual(rows[0]?.identity?.instanceId, dead.instanceId);
  assert.equal(await (await f.forward()).text(), "terminal");
  await f.settle();
});

test("a failure fence stops an earlier reserved call that has not reached dispatch", async () => {
  const f = await fixture(1),
    identity = await f.add(),
    entered = deferred(),
    release = deferred();
  let selected = 0;
  f.cell(identity).selected = async () => {
    if (selected++ === 0) {
      entered.resolve();
      await release.promise;
    }
    return identity;
  };
  f.cell(identity).forward = async (_request, _port, _pool, before) => {
    before();
    throw new Error("runtime transport failed");
  };
  const earlier = assert.rejects(f.forward(), /uncertain/);
  await entered.promise;
  await assert.rejects(f.forward(), /runtime transport failed/);
  release.resolve();
  await earlier;
  await f.settle();
  assert.equal((await f.state.inspect())[0]?.active, 0);
  assert.equal((await f.state.inspect())[0]?.phase, "quarantined");
  assert.deepEqual(f.sends, []);
});

test("reclaimed compute keeps late stream releases and never reuses the failed launch identity", async () => {
  const f = await fixture(1),
    dead = await f.add();
  const first = await f.state.acquire(10),
    second = await f.state.acquire(10);
  await f.state.quarantine(dead);
  await f.state.quarantine(dead);
  assert.equal(await f.state.replacements(), 1);
  await assert.rejects(f.state.ready(dead), /uncertain/);
  await f.state.reclaimQuarantined(dead);
  await first.release();
  await second.release();
  await first.release();
  await f.state.quarantine(dead);
  assert.equal(await f.state.replacements(), 1);
  assert.deepEqual(await f.state.inspect(), []);
  await assert.rejects(f.state.reserve(dead), /identity/);
  const next = { ...dead, slotId: "replacement", instanceId: "new-instance", bootId: "new-boot" };
  await f.state.reserveReplacement(next);
  await f.state.dispatch(next);
  await f.state.ready(next);
  assert.equal(await f.state.replacements(), 0);
  assert.equal((await f.state.acquire(1)).identity.instanceId, next.instanceId);
});

test("at its maximum under sustained demand, a dead cell leaves and its replacement starts, never above the maximum", async () => {
  const f = await fixture(4),
    cells = [await f.add(), await f.add(), await f.add(), await f.add()];
  let next = 100;
  const pending: Promise<unknown>[] = [];
  const fleet = new RuntimeFleet({
    state: f.state,
    target: async () => ({
      format: "pool-runtime-slot-v1",
      controllerId: "controller",
      slotId: `slot-${++next}`,
      instanceId: `instance-${next}`,
      applicationId: "blue",
      applicationVersion: "1",
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageInput: "image",
      homePeerOrdinal: next,
    }),
    cell: f.cell,
    legacyActive: async () => 0,
    // Load that needs all four cells, for as long as the test runs.
    currentRequests: () => 40,
    targetActive: 10,
    idleMilliseconds: 60_000,
    maximum: 4,
    now: Date.now,
    wrap: (response) => response,
    defer: (work) => {
      pending.push(work);
    },
  });
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  const live = async () => {
    const rows = (await f.state.inspect()).filter((row) => row.phase !== "retired");
    assert.ok(rows.length <= 4, `${rows.length} cells above the maximum`);
    return rows;
  };
  const dead = cells[0]!;
  f.cell(dead).forward = async (_request, _port, _pool, before) => {
    before();
    throw new Error("runtime transport failed");
  };
  // Calls go to the dead cell until its failure quarantines it.
  for (let call = 0; call < 4; call++) {
    const answered = await f.forward(undefined, fleet).then(
      (response) => response.text(),
      (error: Error) => error.message,
    );
    if (answered === "runtime transport failed") break;
  }
  await settle();
  assert.equal(
    (await live()).find((row) => row.target.slotId === dead.slotId)?.phase,
    "quarantined",
  );
  // At the maximum the dead row holds its place: no fifth cell starts.
  await fleet.upkeep();
  await settle();
  assert.equal((await live()).length, 4);
  for (let call = 0; call < 6; call++)
    assert.equal(await (await f.forward(undefined, fleet)).text(), "terminal");
  // Proven gone, the dead row leaves and the replacement starts, while demand stays at the maximum.
  f.stop();
  await fleet.upkeep();
  await settle();
  await fleet.upkeep();
  await settle();
  const rows = await live();
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.identity?.instanceId !== dead.instanceId));
  assert.ok(
    rows.every((row) => row.phase === "ready"),
    JSON.stringify(rows.map((row) => row.phase)),
  );
  assert.ok(rows.some((row) => !cells.some((cell) => cell.slotId === row.target.slotId)));
  assert.equal(f.legacyCalls(), 0, "a call fell to the root while three cells served");
});

test("at its maximum under sustained demand, a cell that fails its health twice leaves and is replaced", async (context) => {
  let now = 1_000;
  context.mock.method(Date, "now", () => now);
  context.mock.method(console, "info", () => {});
  const f = await fixture(4),
    cells = [await f.add(), await f.add(), await f.add(), await f.add()];
  const dead = cells[0]!;
  let next = 50;
  const pending: Promise<unknown>[] = [];
  const fleet = new RuntimeFleet({
    state: f.state,
    target: async () => ({
      format: "pool-runtime-slot-v1",
      controllerId: "controller",
      slotId: `slot-${++next}`,
      instanceId: `instance-${next}`,
      applicationId: "blue",
      applicationVersion: "1",
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageInput: "image",
      homePeerOrdinal: next,
    }),
    cell: (target) => ({
      ...f.cell(target),
      healthy: async () => {
        if (target.slotId === dead.slotId) throw new SlotRefused("unhealthy");
      },
    }),
    legacyActive: async () => 0,
    currentRequests: () => 40,
    targetActive: 10,
    idleMilliseconds: 60_000,
    maximum: 4,
    now: () => now,
    wrap: (response) => response,
    defer: (work) => {
      pending.push(work);
    },
  });
  const pass = async () => {
    await fleet.upkeep();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    const rows = (await f.state.inspect()).filter((row) => row.phase !== "retired");
    assert.ok(rows.length <= 4, `${rows.length} cells above the maximum`);
    return rows;
  };
  await pass();
  now += 6_000;
  assert.equal(
    (await pass()).find((row) => row.target.slotId === dead.slotId)?.phase,
    "quarantined",
  );
  f.stop();
  await pass();
  const rows = await pass();
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.identity?.instanceId !== dead.instanceId));
  assert.ok(
    rows.every((row) => row.phase === "ready"),
    JSON.stringify(rows.map((row) => row.phase)),
  );
});
