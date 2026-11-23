import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { failureFleetFixture as fixture } from "../../scripts/pool-tests/runtime-fleet-failure-fixture.ts";
import { HealthLeaseElapsed, SlotRefused, type SlotIdentity } from "./runtime-slots/contract.ts";
import { rememberRuntimeFailure } from "./runtime-route-diagnostic.ts";
import { BoundSlotDriver } from "./runtime-slots/transport.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { readFailure, readFailureRead } from "./runtime-fleet/failure-record.ts";

/** One ready cell whose health reads the test answers, and a fleet that may not start another. */
async function suspectFleet(context: TestContext) {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  const f = await fixture(2),
    cell = await f.add();
  let health: () => Promise<unknown> = async () => undefined;
  let starts = 0;
  const pending: Promise<unknown>[] = [];
  const create = () =>
    new RuntimeFleet({
      state: f.state,
      target: async () => {
        starts++;
        throw new Error("no new cell in this test");
      },
      cell: (target) => ({
        ...f.cell(target),
        healthy: async () => {
          if (target.slotId === cell.slotId) await health();
        },
      }),
      legacyActive: async () => 0,
      currentRequests: () => 0,
      targetActive: 10,
      idleMilliseconds: 60_000,
      maximum: 2,
      now: Date.now,
      wrap: (response) => response,
      defer: (work) => {
        pending.push(work);
      },
    });
  const fleet = create();
  const pass = async (selected = fleet) => {
    await selected.upkeep();
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  const row = async () =>
    (await f.state.inspect()).find((value) => value.target.slotId === cell.slotId);
  return {
    f,
    cell,
    fleet,
    create,
    pass,
    row,
    starts: () => starts,
    answer: (next: () => Promise<unknown>) => {
      health = next;
    },
  };
}
const refuse = () => async () => {
  throw new SlotRefused("unhealthy");
};

test("one failed health read fences a ready cell without quarantining it, and the next good read lets it serve", async (context) => {
  const s = await suspectFleet(context);
  s.answer(refuse());
  await s.pass();
  const suspect = await s.row();
  assert.equal(suspect?.phase, "ready", "one failed read quarantined the cell");
  assert.equal(readFailureRead(suspect?.miss)?.cause, "slot_unhealthy");
  // Nothing reaches the cell while it is suspect: every call goes to the root.
  for (let index = 0; index < 3; index++)
    assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  // Nor from a fresh controller whose local fence is empty: the durable row holds it.
  assert.equal(await (await s.f.forward(undefined, s.create())).text(), "legacy");
  assert.deepEqual(s.f.sends, []);
  assert.equal(s.starts(), 0, "a suspect cell started another");
  assert.deepEqual(await s.f.state.recentEnds(), []);
  s.answer(async () => undefined);
  await s.pass();
  const cleared = await s.row();
  assert.equal(cleared?.phase, "ready");
  assert.equal(cleared?.miss, undefined);
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "terminal");
  assert.deepEqual(s.f.sends, [s.cell.instanceId]);
});

test("a call reserved before the miss is refused at dispatch and counts as no failure", async (context) => {
  const s = await suspectFleet(context);
  const entered = deferred(),
    release = deferred();
  let selected = 0;
  s.f.cell(s.cell).selected = async () => {
    if (selected++ === 0) {
      entered.resolve();
      await release.promise;
    }
    return s.cell;
  };
  const earlier = assert.rejects(s.f.forward(undefined, s.fleet), /uncertain/);
  await entered.promise;
  s.answer(refuse());
  await s.pass();
  release.resolve();
  await earlier;
  const row = await s.row();
  assert.equal(row?.phase, "ready", "the fence's own refusal quarantined the cell");
  assert.equal(row?.active, 0);
  assert.deepEqual(s.f.sends, []);
});

test("two failed health reads in a row quarantine the cell with both causes, and its recent entry says why", async (context) => {
  const s = await suspectFleet(context);
  s.answer(refuse());
  await s.pass();
  s.answer(async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  await s.pass();
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "runtime_failed");
  const failure = readFailure(row?.failure);
  assert.equal(failure?.path, "health");
  assert.deepEqual(
    failure?.reads.map((read) => read.cause),
    ["slot_unhealthy", "timeout"],
  );
  assert.equal(typeof failure?.reads[1]?.roundTripMs, "number");
  // The process is gone: the next pass reclaims the row, with no recorded end.
  s.f.stop();
  await s.pass();
  const [left] = await s.f.state.recentEnds();
  assert.equal(left?.slotId, s.cell.slotId);
  assert.equal(left?.end, null);
  assert.equal(left?.left, "quarantined");
  assert.equal(left?.reason, "runtime_failed");
  assert.deepEqual(readFailure(left?.failure), failure);
});

test("a read that reached another process quarantines the cell on the first read", async (context) => {
  const s = await suspectFleet(context);
  s.answer(async () => {
    throw new SlotRefused("identity");
  });
  await s.pass();
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.deepEqual(
    readFailure(row?.failure)?.reads.map((read) => read.cause),
    ["slot_identity"],
  );
});

test("a health answer slower than the lease it reported is one miss, named as such", async (context) => {
  const identity: SlotIdentity = {
    format: "pool-runtime-slot-v1",
    controllerId: "controller",
    slotId: "slot-lease",
    instanceId: "instance-lease",
    applicationId: "blue",
    applicationVersion: "1",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    homePeerOrdinal: 1,
    bootId: "boot-lease",
  };
  let clock = 1_000;
  context.mock.method(performance, "now", () => clock);
  const driver = new BoundSlotDriver(() => ({
    fetch: async () => {
      clock += 1_612;
      return Response.json({ identity, leaseMs: 1_500 });
    },
  }));
  const error = await driver.health(identity, new AbortController().signal).catch((value) => value);
  assert.ok(error instanceof HealthLeaseElapsed, String(error));
  assert.equal(error.roundTripMs, 1_612);
  assert.equal(error.leaseMs, 1_500);
  context.mock.restoreAll();
  const s = await suspectFleet(context);
  s.answer(async () => {
    throw error;
  });
  await s.pass();
  const row = await s.row();
  assert.equal(row?.phase, "ready");
  assert.deepEqual(
    { ...readFailureRead(row?.miss), at: 0 },
    {
      at: 0,
      step: "endpoint_health",
      cause: "lease_elapsed",
      roundTripMs: 1_612,
      leaseLeftMs: -112,
    },
  );
});

test("a failed forward still quarantines at once, recorded as the forward path", async (context) => {
  const s = await suspectFleet(context);
  s.f.cell(s.cell).forward = async (_request, _port, _pool, before) => {
    before();
    throw new Error("runtime transport failed");
  };
  await assert.rejects(s.f.forward(undefined, s.fleet), /runtime transport failed/);
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(readFailure(row?.failure)?.path, "forward");
  assert.equal(readFailure(row?.failure)?.reads[0]?.cause, "transport");
});

test("a refusal by the router's own health read before the send is a miss too, and a second in a row quarantines", async (context) => {
  const s = await suspectFleet(context);
  s.f.cell(s.cell).forward = async () => {
    const error = new SlotRefused("unhealthy");
    rememberRuntimeFailure("slot_health", error);
    throw error;
  };
  await assert.rejects(s.f.forward(undefined, s.fleet), /unhealthy/);
  const suspect = await s.row();
  assert.equal(suspect?.phase, "ready", "one refused read before the send quarantined the cell");
  assert.equal(readFailureRead(suspect?.miss)?.step, "slot_health");
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  s.answer(refuse());
  await s.pass();
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.deepEqual(
    readFailure(row?.failure)?.reads.map((read) => read.step),
    ["slot_health", "endpoint_health"],
  );
});

test("a good health read never lifts the fence of a quarantine whose write failed", async (context) => {
  const s = await suspectFleet(context);
  s.f.cell(s.cell).forward = async (_request, _port, _pool, before) => {
    before();
    throw new Error("runtime transport failed");
  };
  const write = context.mock.method(s.f.state, "quarantine", async () => {
    throw new Error("storage unavailable");
  });
  await assert.rejects(s.f.forward(undefined, s.fleet), /runtime transport failed/);
  write.mock.restore();
  assert.equal((await s.row())?.phase, "ready");
  s.answer(async () => undefined);
  await s.pass();
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  assert.deepEqual(s.f.sends, []);
});

test("a suspect cell is read again before anything retires it, so a dead idle one quarantines", async (context) => {
  let now = 0;
  context.mock.method(Date, "now", () => now);
  const s = await suspectFleet(context);
  // Idle past the fleet's idle time, with the root serving: an ordinary cell would retire now.
  now = 60_001;
  s.answer(refuse());
  await s.pass();
  assert.equal((await s.row())?.phase, "ready");
  await s.pass();
  assert.equal((await s.row())?.phase, "quarantined");
});
