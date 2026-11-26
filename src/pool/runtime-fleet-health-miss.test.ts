import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { failureFleetFixture as fixture } from "../../scripts/pool-tests/runtime-fleet-failure-fixture.ts";
import {
  ContainerEnded,
  HealthLeaseElapsed,
  SlotRefused,
  type SlotIdentity,
} from "./runtime-slots/contract.ts";
import {
  rememberRuntimeFailure,
  retainRuntimeFailure,
  runtimeFailureHeaders,
} from "./runtime-route-diagnostic.ts";
import { ProtectionRefusal } from "./runtime-protection.ts";
import { FleetFailures } from "./runtime-fleet/failures.ts";
import { BoundSlotDriver } from "./runtime-slots/transport.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { readFailure, readSuspect } from "./runtime-fleet/failure-record.ts";

/**
 * One ready cell whose health reads the test answers, on a clock the test moves, and a fleet that
 * may not start another cell.
 */
async function suspectFleet(context: TestContext) {
  let clock = 0;
  context.mock.method(Date, "now", () => clock);
  const info = context.mock.method(console, "info", () => {});
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
    row,
    starts: () => starts,
    /** Each fleet pass line's failed health reads, in pass order. */
    misses: () =>
      info.mock.calls
        .filter(({ arguments: [name] }) => name === "POOL_RUNTIME_UPKEEP")
        .map(({ arguments: [, line] }) => line as { phase: string; misses?: unknown[] })
        .filter((line) => line.phase === "upkeep")
        .map((line) => line.misses),
    /** One upkeep pass at `at` ms, answering this cell's health read with `answer`. */
    read: async (at: number, answer: () => Promise<unknown>) => {
      clock = at;
      health = answer;
      await pass();
    },
  };
}
const refuse = async () => {
  throw new SlotRefused("unhealthy");
};
const timeout = async () => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};
const late = async () => {
  throw new HealthLeaseElapsed(1_612, 1_500);
};
const good = async () => undefined;

test("one failed health read fences a ready cell without quarantining it, and the next good read lets it serve", async (context) => {
  const s = await suspectFleet(context);
  await s.read(0, refuse);
  const suspect = await s.row();
  assert.equal(suspect?.phase, "ready", "one failed read quarantined the cell");
  assert.equal(readSuspect(suspect?.suspect)?.failed?.cause, "slot_unhealthy");
  // Nothing reaches the cell while it is suspect: every call goes to the root.
  for (let index = 0; index < 3; index++)
    assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  // Nor from a fresh controller whose local fence is empty: the durable row holds it.
  assert.equal(await (await s.f.forward(undefined, s.create())).text(), "legacy");
  assert.deepEqual(s.f.sends, []);
  assert.equal(s.starts(), 0, "a suspect cell started another");
  assert.deepEqual(await s.f.state.recentEnds(), []);
  await s.read(2_000, good);
  const cleared = await s.row();
  assert.equal(cleared?.phase, "ready");
  assert.equal(cleared?.suspect, undefined);
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
  await s.read(0, refuse);
  release.resolve();
  await earlier;
  const row = await s.row();
  assert.equal(row?.phase, "ready", "the fence's own refusal quarantined the cell");
  assert.equal(row?.active, 0);
  assert.deepEqual(s.f.sends, []);
});

test("two failed reads 2 s apart do not quarantine; the same two 6 s apart do, with both causes", async (context) => {
  const near = await suspectFleet(context);
  await near.read(0, refuse);
  await near.read(2_000, timeout);
  assert.equal((await near.row())?.phase, "ready", "two reads 2 s apart quarantined the cell");
  context.mock.restoreAll();
  const s = await suspectFleet(context);
  await s.read(0, refuse);
  await s.read(6_000, timeout);
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(row?.reason, "runtime_failed");
  const failure = readFailure(row?.failure);
  assert.equal(failure?.path, "health");
  assert.equal(failure?.rule, "failed_twice");
  assert.deepEqual(
    failure?.reads.map((read) => [read.at, read.cause]),
    [
      [0, "slot_unhealthy"],
      [6_000, "timeout"],
    ],
  );
  assert.equal(typeof failure?.reads[1]?.roundTripMs, "number");
  // Each pass line says which miss quarantined the cell, on its own.
  assert.deepEqual(
    s
      .misses()
      .map((misses) =>
        (misses as Array<{ ordinal: number; quarantined: boolean; cause: string }>).map(
          ({ ordinal, quarantined, cause }) => [ordinal, quarantined, cause],
        ),
      ),
    [
      [[s.cell.homePeerOrdinal, false, "slot_unhealthy"]],
      [[s.cell.homePeerOrdinal, true, "timeout"]],
    ],
  );
  // The process is gone: the next pass reclaims the row, with no recorded end.
  s.f.stop();
  await s.read(8_000, good);
  const [left] = await s.f.state.recentEnds();
  assert.equal(left?.slotId, s.cell.slotId);
  assert.equal(left?.end, null);
  assert.equal(left?.left, "quarantined");
  assert.equal(left?.reason, "runtime_failed");
  assert.deepEqual(readFailure(left?.failure), failure);
});

test("a read that reached another process quarantines the cell on the first read", async (context) => {
  const s = await suspectFleet(context);
  await s.read(0, async () => {
    throw new SlotRefused("identity");
  });
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(readFailure(row?.failure)?.rule, "evidence");
  assert.deepEqual(
    readFailure(row?.failure)?.reads.map((read) => read.cause),
    ["slot_identity"],
  );
});

test("the transport names a health answer slower than the lease it reported", async (context) => {
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
  context.mock.method(console, "error", () => {});
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
});

test("a cell answering late for 10 s fences, then answers on time and serves again, with nothing recorded", async (context) => {
  const s = await suspectFleet(context);
  for (let at = 0; at <= 10_000; at += 2_000) {
    await s.read(at, late);
    assert.equal((await s.row())?.phase, "ready", `a late answer at ${at} ms quarantined the cell`);
    assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  }
  const suspect = readSuspect((await s.row())?.suspect);
  assert.equal(suspect?.failed, undefined, "a late answer counted as a failed read");
  assert.deepEqual(
    { ...suspect?.reads.at(-1), at: 0 },
    {
      at: 0,
      step: "endpoint_health",
      cause: "lease_elapsed",
      roundTripMs: 1_612,
      leaseLeftMs: -112,
    },
  );
  await s.read(12_000, good);
  assert.equal((await s.row())?.suspect, undefined);
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "terminal");
  assert.deepEqual(await s.f.state.recentEnds(), []);
});

test("a cell answering late for 30 s is quarantined as unproven, with the reads it had", async (context) => {
  const s = await suspectFleet(context);
  for (let at = 0; at < 30_000; at += 2_000) await s.read(at, late);
  assert.equal((await s.row())?.phase, "ready");
  await s.read(30_000, late);
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  const failure = readFailure(row?.failure);
  assert.equal(failure?.rule, "unproven");
  assert.ok(failure && failure.reads.length > 0);
  assert.ok(failure?.reads.every((read) => read.cause === "lease_elapsed"));
});

test("late answers never shorten the path to the two-miss quarantine", async (context) => {
  const s = await suspectFleet(context);
  // A failed read, then a late answer 6 s on: the late one is no second failure.
  await s.read(0, refuse);
  await s.read(6_000, late);
  assert.equal((await s.row())?.phase, "ready");
  context.mock.restoreAll();
  const t = await suspectFleet(context);
  // Late answers first, then two failed reads 2 s apart: the 6 s run from the first failure.
  await t.read(0, late);
  await t.read(2_000, refuse);
  await t.read(4_000, refuse);
  assert.equal((await t.row())?.phase, "ready");
  await t.read(8_000, refuse);
  assert.equal(readFailure((await t.row())?.failure)?.rule, "failed_twice");
  context.mock.restoreAll();
  const u = await suspectFleet(context);
  // A late answer opens the episode, but the 6 s count from the first failure, not from it.
  await u.read(0, late);
  await u.read(2_000, refuse);
  await u.read(6_000, refuse);
  assert.equal((await u.row())?.phase, "ready", "the 6 s ran from the late answer");
  await u.read(8_000, refuse);
  assert.equal((await u.row())?.phase, "quarantined");
});

test("a lease too short for the router's own check fences, but never counts as a failed read", async (context) => {
  const s = await suspectFleet(context);
  s.f.cell(s.cell).forward = async () => {
    const error = new ProtectionRefusal("lease_too_short");
    rememberRuntimeFailure("slot_protection", error);
    throw error;
  };
  await assert.rejects(s.f.forward(undefined, s.fleet));
  const suspect = readSuspect((await s.row())?.suspect);
  assert.equal(suspect?.reads.at(-1)?.cause, "protection_lease_too_short");
  assert.equal(suspect?.failed, undefined, "a short lease counted as a failed read");
  // One counted failure 6 s on is still only one.
  await s.read(6_000, refuse);
  assert.equal((await s.row())?.phase, "ready");
});

test("a good read that began before a newer failure never lifts that failure's fence", async (context) => {
  const s = await suspectFleet(context);
  const failures = new FleetFailures(s.f.state, () => {}, Date.now);
  const read = (at: number) => ({
    at,
    step: "endpoint_health" as const,
    cause: "slot_unhealthy" as const,
  });
  await failures.missed(s.cell, read(1_500));
  await failures.recovered(s.cell, 1_000);
  assert.ok(readSuspect((await s.row())?.suspect), "an older good read cleared the newer failure");
  assert.equal(failures.fenced(s.cell), true);
  await failures.recovered(s.cell, 2_000);
  assert.equal((await s.row())?.suspect, undefined);
  assert.equal(failures.fenced(s.cell), false);
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
  assert.equal(readFailure(row?.failure)?.rule, "evidence");
  assert.equal(readFailure(row?.failure)?.reads[0]?.cause, "transport");
});

test("a refusal by a health read before the send, the router's or the endpoint's, is a miss too", async (context) => {
  const endpoint = await suspectFleet(context);
  endpoint.f.cell(endpoint.cell).forward = async () => {
    const error = new SlotRefused("unhealthy");
    rememberRuntimeFailure("endpoint_health", error);
    throw error;
  };
  await assert.rejects(endpoint.f.forward(undefined, endpoint.fleet), /unhealthy/);
  assert.equal(
    (await endpoint.row())?.phase,
    "ready",
    "the endpoint's refusal quarantined the cell",
  );
  context.mock.restoreAll();
  const s = await suspectFleet(context);
  s.f.cell(s.cell).forward = async () => {
    const error = new SlotRefused("unhealthy");
    rememberRuntimeFailure("slot_health", error);
    throw error;
  };
  await assert.rejects(s.f.forward(undefined, s.fleet), /unhealthy/);
  const suspect = await s.row();
  assert.equal(suspect?.phase, "ready", "one refused read before the send quarantined the cell");
  assert.equal(readSuspect(suspect?.suspect)?.failed?.step, "slot_health");
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  await s.read(6_000, refuse);
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
  await s.read(2_000, good);
  assert.equal(await (await s.f.forward(undefined, s.fleet)).text(), "legacy");
  assert.deepEqual(s.f.sends, []);
});

test("a suspect cell is read again before anything retires it, so a dead idle one quarantines", async (context) => {
  const s = await suspectFleet(context);
  // Idle past the fleet's idle time, with the root serving: an ordinary cell would retire now.
  await s.read(60_001, refuse);
  assert.equal((await s.row())?.phase, "ready");
  await s.read(66_001, refuse);
  assert.equal((await s.row())?.phase, "quarantined");
});

test("a good read never lifts a newer miss's fence, even when that miss's own write was refused", async (context) => {
  const s = await suspectFleet(context);
  const failures = new FleetFailures(s.f.state, () => {}, Date.now);
  const read = (at: number) => ({
    at,
    step: "endpoint_health" as const,
    cause: "slot_unhealthy" as const,
  });
  await failures.missed(s.cell, read(0));
  // The second miss would quarantine, but its write is refused, as at the replacement cap.
  const write = context.mock.method(s.f.state, "suspect", async () => {
    throw new Error("quarantine refused");
  });
  await failures.missed(s.cell, read(8_000)).catch(() => {});
  write.mock.restore();
  await failures.recovered(s.cell, 7_000);
  assert.equal(failures.fenced(s.cell), true, "an older good read lifted the newer miss");
  assert.ok(readSuspect((await s.row())?.suspect));
});

test("the endpoint's keep-alive failing before a send is forward evidence, not a health read", async (context) => {
  const s = await suspectFleet(context);
  s.f.cell(s.cell).forward = async () => {
    const error = new Error("setInactivityTimeout failed");
    rememberRuntimeFailure("endpoint_health", error);
    throw error;
  };
  await assert.rejects(s.f.forward(undefined, s.fleet), /setInactivityTimeout failed/);
  const row = await s.row();
  assert.equal(row?.phase, "quarantined");
  assert.equal(readFailure(row?.failure)?.rule, "evidence");
});

test("a lapsed policy lease as production logs it, endpoint_identity with slot_unhealthy, is a miss on both paths", async (context) => {
  // Home answered its readiness read, but the policy lease in the answer had run out: the endpoint
  // refuses with SlotRefused("unhealthy") under endpoint_identity, and the transport carries it on.
  const remote = () => {
    const local = new SlotRefused("unhealthy");
    rememberRuntimeFailure("endpoint_identity", local);
    return retainRuntimeFailure(
      new Response(null, {
        status: 409,
        headers: runtimeFailureHeaders(local, "endpoint_identity"),
      }),
      new SlotRefused("uncertain"),
    );
  };
  const s = await suspectFleet(context);
  await s.read(0, async () => {
    throw remote();
  });
  const suspect = await s.row();
  assert.equal(suspect?.phase, "ready", "the upkeep read quarantined the cell at once");
  assert.deepEqual(
    [readSuspect(suspect?.suspect)?.failed?.step, readSuspect(suspect?.suspect)?.failed?.cause],
    ["endpoint_identity", "slot_unhealthy"],
  );
  context.mock.restoreAll();
  const t = await suspectFleet(context);
  t.f.cell(t.cell).forward = async () => {
    const error = remote();
    rememberRuntimeFailure("slot_health", error);
    throw error;
  };
  await assert.rejects(t.f.forward(undefined, t.fleet));
  assert.equal((await t.row())?.phase, "ready", "the router's read quarantined the cell at once");
  assert.ok(readSuspect((await t.row())?.suspect));
});

test("a stopped container whose own monitor recorded its exit quarantines at once, on both paths", async (context) => {
  const remote = () => {
    const local = new ContainerEnded();
    rememberRuntimeFailure("endpoint_identity", local);
    return retainRuntimeFailure(
      new Response(null, {
        status: 409,
        headers: runtimeFailureHeaders(local, "endpoint_identity"),
      }),
      new SlotRefused("uncertain"),
    );
  };
  const s = await suspectFleet(context);
  await s.read(0, async () => {
    throw remote();
  });
  const row = await s.row();
  assert.equal(row?.phase, "quarantined", "a recorded exit waited for the 6 s rule");
  assert.equal(readFailure(row?.failure)?.rule, "evidence");
  assert.equal(readFailure(row?.failure)?.reads[0]?.ended, true);
  context.mock.restoreAll();
  const t = await suspectFleet(context);
  t.f.cell(t.cell).forward = async () => {
    const error = remote();
    rememberRuntimeFailure("slot_health", error);
    throw error;
  };
  await assert.rejects(t.f.forward(undefined, t.fleet));
  assert.equal((await t.row())?.phase, "quarantined");
});
