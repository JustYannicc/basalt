import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import type { SlotIdentity, SlotTarget } from "./runtime-slots/contract.ts";
import type { NativeStreamLease } from "./native-streams.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";

const responseModule = "./native-response.worker.ts";
const { nativeResponse } = (await import(responseModule)) as {
  nativeResponse(response: Response, lease: NativeStreamLease): Response;
};

function fixture(maximum = 4, targetActive = 1) {
  const state = new RuntimeFleetState(new SlotMemory(), maximum, () => 100);
  const pending: Promise<unknown>[] = [];
  const cells = new Map<string, FleetCell>();
  const selected = new Map<string, SlotIdentity>();
  const calls = { starts: 0, dispatches: 0, legacy: 0, installs: 0, retires: 0 };
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  let index = 0,
    pressure = 0,
    retirementLost = false,
    now = 200;
  const demandAlarms: number[] = [];
  const target = (): SlotIdentity => ({
    format: "pool-runtime-slot-v1",
    controllerId: "controller",
    slotId: `slot-${++index}`,
    applicationId: "blue",
    applicationVersion: "1",
    instanceId: `instance-${index}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    homePeerOrdinal: index,
    bootId: `boot-${index}`,
  });
  const cell = (value: SlotTarget) => {
    const existing = cells.get(value.slotId);
    if (existing) return existing;
    let retired = false;
    const next: FleetCell = {
      start: async () => {
        calls.starts++;
        const identity = { ...value, bootId: `boot-${value.homePeerOrdinal}` };
        selected.set(value.slotId, identity);
        return identity;
      },
      observe: async () => selected.get(value.slotId),
      selected: async () => selected.get(value.slotId),
      forward: async (_request, _port, _pool, beforeDispatch) => {
        beforeDispatch();
        calls.dispatches++;
        return new Response(
          new ReadableStream({
            start(controller) {
              bodies.push(controller);
            },
          }),
        );
      },
      install: async () => {
        calls.installs++;
      },
      abortPool: () => {},
      drain: async () => ({ active: 0, known: true }),
      retire: async (_identity, begin) => {
        await begin();
        calls.retires++;
        retired = true;
        if (retirementLost) throw new Error("lost retirement acknowledgement");
      },
      retired: async () => retired,
      failed: async () => false,
    };
    cells.set(value.slotId, next);
    return next;
  };
  const fleet = new RuntimeFleet({
    state,
    target: async () => target(),
    cell,
    legacyActive: async () => pressure,
    currentRequests: () => pressure,
    targetActive,
    maximum,
    idleMilliseconds: 50,
    defer: (work) => {
      pending.push(work);
    },
    wrap: nativeResponse,
    now: () => now,
    demandAt: (at) => {
      demandAlarms.push(at);
    },
  });
  const add = async () => {
    const value = target();
    await state.reserve(value);
    await state.dispatch(value);
    selected.set(value.slotId, value);
    await state.ready(value);
    return value;
  };
  const legacy = async () => {
    calls.legacy++;
    return new Response("legacy");
  };
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return {
    state,
    fleet,
    target,
    cell,
    add,
    calls,
    selected,
    bodies,
    legacy,
    settle,
    demandAlarms,
    advance: (at: number) => {
      now = at;
    },
    pressure: (value: number) => {
      pressure = value;
    },
    loseRetirement: () => {
      retirementLost = true;
    },
  };
}
const request = () => new Request("https://synthetic.invalid/v1/responses", { method: "POST" });

test("a burst inside the growth throttle arms one demand deadline and expands without another request", async () => {
  const f = fixture(3, 2);
  await (await f.fleet.forward(request(), "pool", f.legacy, () => {})).text();
  await f.settle();
  assert.equal(f.calls.starts, 0);
  f.pressure(6);
  await Promise.all(
    [1, 2, 3].map(async () =>
      (await f.fleet.forward(request(), "pool", f.legacy, () => {})).text(),
    ),
  );
  await f.settle();
  assert.deepEqual(f.demandAlarms, [300]);
  assert.equal(f.calls.starts, 0);
  f.advance(300);
  await f.fleet.upkeep();
  await f.settle();
  assert.equal(f.calls.starts, 3);
});

test("demand starts several named runtimes while legacy keeps serving the triggering request", async () => {
  const f = fixture(3, 2);
  f.pressure(6);
  assert.equal(
    await (await f.fleet.forward(request(), "pool", f.legacy, () => {})).text(),
    "legacy",
  );
  await f.settle();
  assert.equal(f.calls.starts, 3);
  assert.equal(f.calls.legacy, 1);
  const responses = await Promise.all(
    [1, 2, 3].map(() => f.fleet.forward(request(), "pool", f.legacy, () => {})),
  );
  assert.deepEqual(
    (await f.state.inspect()).map((row) => row.active),
    [1, 1, 1],
  );
  await Promise.all(responses.map((response) => response.body!.cancel()));
  await f.settle();
});

test("the growth target never rejects extra work at the approved resource ceiling", async () => {
  const f = fixture(1, 1);
  await f.add();
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => f.fleet.forward(request(), "pool", f.legacy, () => {})),
  );
  assert.equal(f.calls.dispatches, 10);
  assert.equal((await f.state.inspect())[0]?.active, 10);
  await Promise.all(responses.map((response) => response.body!.cancel()));
  await f.settle();
  assert.equal((await f.state.inspect())[0]?.active, 0);
});

test("planned drain lets an accepted delayed response finish before a single retirement", async () => {
  const f = fixture();
  const identity = await f.add();
  const cell = f.cell(identity),
    header = deferred();
  const original = cell.forward;
  cell.forward = async (...args) => {
    args[3]();
    await header.promise;
    return original(args[0], args[1], args[2], () => {});
  };
  const response = f.fleet.forward(request(), "pool", f.legacy, () => {});
  // The durable reservation marks acceptance before delayed upstream headers.
  const held = deferred();
  cell.selected = async () => {
    held.resolve();
    return identity;
  };
  await held.promise;
  await f.state.drain(identity);
  await f.fleet.upkeep();
  assert.equal(f.calls.retires, 0);
  header.resolve();
  const delivered = await response;
  const terminal = delivered.text();
  f.bodies[0]!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
  f.bodies[0]!.close();
  assert.equal(await terminal, "data: [DONE]\n\n");
  await f.settle();
  await f.fleet.upkeep();
  assert.equal(f.calls.retires, 1);
  assert.equal((await f.state.inspect()).length, 0);
});

test("lost retirement acknowledgement is inspected without repeating destruction", async () => {
  const f = fixture();
  const identity = await f.add();
  await f.state.drain(identity);
  f.loseRetirement();
  await assert.rejects(f.fleet.upkeep(), /lost retirement/);
  assert.equal((await f.state.inspect())[0]?.phase, "retiring");
  await f.fleet.upkeep();
  assert.equal(f.calls.retires, 1);
  assert.equal((await f.state.inspect()).length, 0);
});

test("a failure after upstream dispatch is never retried on legacy", async () => {
  const f = fixture();
  const identity = await f.add();
  f.cell(identity).forward = async (_request, _port, _pool, beforeDispatch) => {
    beforeDispatch();
    f.calls.dispatches++;
    throw new Error("lost upstream reply");
  };
  await assert.rejects(
    f.fleet.forward(request(), "pool", f.legacy, () => {}),
    /lost upstream reply/,
  );
  assert.equal(f.calls.dispatches, 1);
  assert.equal(f.calls.legacy, 0);
  assert.equal((await f.state.inspect())[0]?.active, 0);
});

test("membership fanout includes an activated cell whose ready acknowledgement is still pending", async () => {
  const f = fixture();
  const identity = f.target();
  await f.state.reserve(identity);
  await f.state.dispatch(identity);
  f.selected.set(identity.slotId, identity);
  await f.fleet.install({
    pool: "pool",
    organization: "org",
    revision: 2,
    dirty: true,
    accounts: [],
    expiresAt: 1000,
  });
  assert.equal(f.calls.installs, 1);
});

test("a pre-dispatch selection failure releases its reservation and lets planned drain finish", async (context) => {
  const f = fixture();
  const identity = await f.add();
  const entered = deferred(),
    release = deferred(),
    fenced = deferred();
  f.cell(identity).selected = async () => {
    entered.resolve();
    await release.promise;
    throw new Error("selection unavailable");
  };
  const originalDrain = f.state.drain.bind(f.state);
  context.mock.method(f.state, "drain", async (value: SlotIdentity) => {
    const active = await originalDrain(value);
    fenced.resolve();
    return active;
  });
  const request = f.fleet.forward(
    new Request("http://pool/v1/responses"),
    undefined,
    f.legacy,
    () => {},
  );
  const rejected = assert.rejects(request, /selection unavailable/);
  await entered.promise;
  const draining = f.fleet.drain(identity);
  await fenced.promise;
  assert.equal((await f.state.inspect())[0]?.active, 1);
  release.resolve();
  await rejected;
  assert.deepEqual(await draining, { active: 0, known: true });
  assert.equal((await f.state.inspect())[0]?.active, 0);
  assert.equal(f.calls.dispatches, 0);
  assert.equal(f.calls.legacy, 0);
});
