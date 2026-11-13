import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotMemory, deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { RuntimeFleet } from "./runtime-fleet/controller.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import { SlotRefused, type SlotIdentity, type SlotTarget } from "./runtime-slots/contract.ts";
import { rememberRuntimeFailure } from "./runtime-route-diagnostic.ts";
import type { NativeStreamLease } from "./native-streams.ts";

const responseModule = "./native-response.worker.ts";
const {
  nativeResponse,
}: {
  nativeResponse(response: Response, lease: NativeStreamLease): Response;
} = await import(responseModule);

async function fixture(maximum = 2) {
  const memory = new SlotMemory(),
    state = new RuntimeFleetState(memory, maximum);
  const pending: Promise<unknown>[] = [],
    sends: string[] = [];
  let sequence = 0,
    legacyCalls = 0,
    stopped = false;
  const target = (): SlotIdentity => ({
    format: "pool-runtime-slot-v1",
    controllerId: "controller",
    slotId: `slot-${++sequence}`,
    instanceId: `instance-${sequence}`,
    applicationId: "blue",
    applicationVersion: "1",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "image",
    homePeerOrdinal: sequence,
    bootId: `boot-${sequence}`,
  });
  const cells = new Map<string, ReturnType<typeof createCell>>();
  function createCell(value: SlotTarget) {
    const identity = { ...value, bootId: `boot-${value.homePeerOrdinal}` };
    return {
      start: async () => identity,
      observe: async () => identity,
      selected: async () => identity,
      forward: async (
        _request: Request,
        _port: 8317,
        _pool: string | undefined,
        before: () => void,
      ) => {
        before();
        sends.push(value.instanceId);
        return new Response("terminal");
      },
      install: async () => {},
      abortPool: () => {},
      drain: async () => ({ active: 0, known: true }),
      retire: async (_identity: SlotIdentity, begin: () => Promise<void>) => begin(),
      retired: async () => true,
      failed: async () => stopped,
    };
  }
  const cell = (value: SlotTarget) => {
    let existing = cells.get(value.slotId);
    if (!existing) {
      existing = createCell(value);
      cells.set(value.slotId, existing);
    }
    return existing;
  };
  const createFleet = () =>
    new RuntimeFleet({
      state,
      target: async () => target(),
      cell,
      legacyActive: async () => 0,
      currentRequests: () => 0,
      targetActive: 10,
      idleMilliseconds: 60_000,
      maximum,
      now: Date.now,
      wrap: nativeResponse,
      defer: (work) => {
        pending.push(work);
      },
    });
  const fleet = createFleet();
  const add = async () => {
    const identity = target();
    await state.reserve(identity);
    await state.dispatch(identity);
    await state.ready(identity);
    return identity;
  };
  const forward = (signal?: AbortSignal, selected = fleet) =>
    selected.forward(
      new Request("http://pool/v1/responses", { signal }),
      "pool",
      async () => {
        legacyCalls++;
        return new Response("legacy");
      },
      () => {},
    );
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return {
    state,
    cell,
    add,
    fleet,
    forward,
    createFleet,
    settle,
    sends,
    legacyCalls: () => legacyCalls,
    stop: () => {
      stopped = true;
    },
  };
}

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
  assert.equal(
    (await f.state.inspect()).find((row) => row.target.slotId === dead.slotId)?.phase,
    "quarantined",
  );
  const reconstructed = f.createFleet();
  for (let index = 0; index < 11; index++)
    assert.equal(await (await f.forward(undefined, reconstructed)).text(), "terminal");
  await f.settle();
  assert.equal(attempts, 1);
  assert.equal(f.legacyCalls(), 0);
  assert.deepEqual(new Set(f.sends), new Set([sibling.instanceId]));
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
