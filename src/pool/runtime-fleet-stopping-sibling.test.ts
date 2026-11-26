import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { runtimeProofFixture } from "../../scripts/pool-fleet/test/runtime-proof-fixture.ts";
import { runtimeApplicationConfigDigest } from "../../scripts/pool-fleet/runtime-slot-manifest.ts";
import {
  destroyedInstance,
  envelope,
  runningInstance,
} from "../../scripts/pool-fleet/test/cloudflare-shapes.ts";
import { decodeProviderApplication } from "./runtime-provider/application.ts";
import { RuntimeProviderReader } from "./runtime-provider/read.ts";
import { RuntimeFleet, type FleetCell } from "./runtime-fleet/controller.ts";
import { FleetRefused, RuntimeFleetState } from "./runtime-fleet/state.ts";
import { upkeepCadenceMs } from "./runtime-fleet/phase-bounds.ts";
import type { SlotIdentity, SlotTarget } from "./runtime-slots/contract.ts";

type Listed = "provisioning" | "running" | "stopping" | "inactive";

/**
 * Up to four cells of one application under the real controller and ledger. Each cell reads the
 * provider as `FleetHandoffCell` does, through the real reader: its activation is the attested
 * observation of its named instance, its retirement the named observation before the stop, and its
 * end the absence proof after the driver reports it stopped. The listing is the test's, built from
 * recorded shapes: a started instance runs (a slow one is provisioning until the test boots it), a
 * retired or crashed one is stopping until the test ends its stop, and then it is listed inactive,
 * as production lists a destroyed instance.
 */
async function stoppingFleet(context: TestContext) {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "warn", () => {});
  context.mock.method(console, "error", () => {});
  const proof = await runtimeProofFixture();
  proof.raw.max_instances = 4;
  const application = {
    ...proof.manifest.provider,
    applicationId: proof.raw.id,
    applicationVersion: "1",
    imageDigest: proof.manifest.target.imageDigest,
    applicationConfigDigest: runtimeApplicationConfigDigest(decodeProviderApplication(proof.raw)),
  };
  const listed = new Map<string, Listed>();
  let now = 1_000_000,
    demand = 0,
    sequence = 0,
    peak = 0;
  const physical = () => [...listed.values()].filter((state) => state !== "inactive").length;
  const list = (instanceId: string, state: Listed) => {
    listed.set(instanceId, state);
    peak = Math.max(peak, physical());
  };
  const instance = (id: string, state: Listed) => {
    const image = proof.raw.configuration.image;
    if (state === "inactive") return destroyedInstance(id, image, proof.raw.id);
    const shape = runningInstance(id, image, proof.raw.id);
    return { ...shape, status: { ...shape.status, state } };
  };
  const reader = new RuntimeProviderReader(
    "synthetic-provider-token",
    async (input) =>
      Response.json(
        new URL(input).pathname.endsWith("instances-v2")
          ? {
              ...envelope([...listed].map(([id, state]) => instance(id, state))),
              result_info: { next_page_token: "" },
            }
          : envelope(proof.raw),
      ),
    () => now,
  );
  const slots = new Map<string, SlotIdentity>();
  const idle = new Set<string>(),
    slow = new Set<string>();
  // The driver reports the container stopped only once its instance is listed inactive.
  const gone = async (identity: SlotIdentity) =>
    listed.get(identity.instanceId) === "inactive" &&
    reader.absent(application, identity.instanceId, undefined, { driverStopped: true });
  const attest = async (target: SlotTarget) => {
    await reader.observe("attested", application, target.instanceId);
    const identity = { ...target, bootId: `boot-${target.slotId}` };
    slots.set(target.slotId, identity);
    return identity;
  };
  const cell = (target: SlotTarget): FleetCell => ({
    start: async () => {
      // The compute start reaches the provider before activation reads it.
      list(target.instanceId, slow.has(target.slotId) ? "provisioning" : "running");
      return attest(target);
    },
    // A start already sent is activated again by upkeep, never sent twice.
    observe: async () =>
      slots.get(target.slotId) ?? (listed.has(target.instanceId) ? attest(target) : undefined),
    selected: async () => slots.get(target.slotId),
    healthy: async () => {
      if (listed.get(target.instanceId) !== "running") throw new Error("synthetic ended runtime");
    },
    forward: async () => new Response("opaque"),
    install: async () => {},
    abortPool: () => {},
    drain: async () => ({ active: 0, known: true }),
    retire: async (identity, begin) => {
      await reader.observe("retire", application, identity.instanceId);
      await begin();
      list(identity.instanceId, "stopping");
      // The stop outlasts this call; a later pass's retirement read picks it up.
      return false;
    },
    retired: gone,
    failed: gone,
  });
  const state = new RuntimeFleetState(new SlotMemory(), 4, () => now);
  const pending: Promise<unknown>[] = [];
  const fleet = new RuntimeFleet({
    state,
    target: async (occupied) => {
      const ordinal = Array.from({ length: 128 }, (_, index) => index + 1).find(
        (value) => !occupied.some((entry) => entry.homePeerOrdinal === value),
      );
      const slot = `slot-${String.fromCharCode(97 + sequence++)}`;
      return {
        format: "pool-runtime-slot-v1",
        controllerId: "root",
        slotId: slot,
        instanceId: `instance-${slot}`,
        applicationId: proof.raw.id,
        applicationVersion: "1",
        imageDigest: proof.manifest.target.imageDigest,
        imageInput: proof.manifest.target.imageInput,
        homePeerOrdinal: ordinal,
      };
    },
    cell,
    legacyActive: async () => 0,
    currentRequests: () => demand,
    targetActive: 1,
    idleMilliseconds: 1,
    maximum: 4,
    now: () => now,
    wrap: (response) => response,
    defer: (work) => {
      pending.push(work);
    },
    // Only a cell the test lets go idles out; the rest stay ready.
    keepReady: async (identity) => !idle.has(identity.slotId),
  });
  const phase = async (slot: string) =>
    (await state.inspect()).find((row) => row.target.slotId === slot)?.phase;
  const instanceOf = (slot: string) => `instance-${slot}`;
  /** One upkeep pass, its growth included; the ledger never counts fewer than the provider holds. */
  const pass = async () => {
    now += upkeepCadenceMs;
    await fleet.upkeep();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    const counted = await state.physicalCount();
    assert.ok(counted >= physical(), `ledger ${counted} below provider ${physical()}`);
    assert.ok(counted <= 4, `ledger ${counted}`);
  };
  return {
    state,
    phase,
    pass,
    peak: () => peak,
    listed: (slot: string) => listed.get(instanceOf(slot)),
    demand: (value: number) => {
      demand = value;
    },
    letIdle: (slot: string) => idle.add(slot),
    /** `slot`'s start is listed provisioning, its activation refused, until `boot`. */
    slowStart: (slot: string) => slow.add(slot),
    boot: (slot: string) => list(instanceOf(slot), "running"),
    ends: async () =>
      Object.fromEntries((await state.recentEnds()).map((end) => [end.slotId, end.left])),
    /** The container ends on its own; the provider lists it stopping until `endStop`. */
    crash: (slot: string) => list(instanceOf(slot), "stopping"),
    endStop: (slot: string) => list(instanceOf(slot), "inactive"),
    /** Passes until `slot` reaches `wanted`, at most ten. */
    until: async (slot: string, wanted: string) => {
      for (let index = 0; index < 10 && (await phase(slot)) !== wanted; index++) await pass();
      assert.equal(await phase(slot), wanted, slot);
    },
  };
}

/** The slots one call each can reach now: every runtime the ledger would hand a call to. */
async function callable(state: RuntimeFleetState) {
  const acquire = () => state.acquire(1);
  const taken: Awaited<ReturnType<typeof acquire>>[] = [];
  try {
    while (taken.length < 5) taken.push(await acquire());
    assert.fail("more runtimes took a call than the fleet holds");
  } catch (error) {
    if (!(error instanceof FleetRefused) || error.reason !== "capacity") throw error;
  }
  await Promise.all(taken.map((reservation) => reservation.release()));
  return taken.map((reservation) => reservation.identity.slotId).sort();
}

test("a start beside a stopping sibling proceeds, and retire, start and crash never take the fleet past four instances", async (context) => {
  const f = await stoppingFleet(context);
  f.demand(3);
  await f.pass();
  for (const slot of ["slot-a", "slot-b", "slot-c"]) assert.equal(await f.phase(slot), "ready");
  // A retires; its stop outlasts the retire call, so its instance is still stopping.
  f.letIdle("slot-a");
  await f.until("slot-a", "retiring");
  assert.equal(f.listed("slot-a"), "stopping");
  // Demand comes back while A stops: D starts and serves beside it, and A still holds its place.
  f.demand(4);
  await f.pass();
  assert.equal(await f.phase("slot-d"), "ready");
  assert.equal(f.listed("slot-a"), "stopping");
  assert.equal(await f.state.physicalCount(), 4);
  // C crashes and its instance is stopping too: the fleet wants a fourth serving cell, but holds.
  f.crash("slot-c");
  await f.until("slot-c", "quarantined");
  await f.pass();
  assert.equal(await f.phase("slot-e"), undefined);
  // A's stop ends, but its absence waits while C may still be running.
  f.endStop("slot-a");
  await f.pass();
  assert.equal(await f.phase("slot-a"), "retiring");
  assert.equal(await f.phase("slot-e"), undefined);
  // Once C's stop ends too, both places free and growth fills them beside the inactive two.
  f.endStop("slot-c");
  await f.pass();
  // Both rows left the ledger.
  assert.equal(await f.phase("slot-a"), undefined);
  assert.equal(await f.phase("slot-c"), undefined);
  for (const slot of ["slot-b", "slot-d", "slot-e", "slot-f"])
    assert.equal(await f.phase(slot), "ready", slot);
  assert.equal(await f.state.physicalCount(), 4);
  // The provider held exactly four running or stopping instances at its fullest, never five.
  assert.equal(f.peak(), 4);
});

test("a call never reaches a cell that is draining, retiring or crashed, only a ready one that runs", async (context) => {
  const f = await stoppingFleet(context);
  f.demand(3);
  await f.pass();
  assert.deepEqual(await callable(f.state), ["slot-a", "slot-b", "slot-c"]);
  f.letIdle("slot-a");
  await f.until("slot-a", "draining");
  assert.deepEqual(await callable(f.state), ["slot-b", "slot-c"]);
  await f.until("slot-a", "retiring");
  assert.equal(f.listed("slot-a"), "stopping");
  assert.deepEqual(await callable(f.state), ["slot-b", "slot-c"]);
  // D starts beside the stopping A and takes calls; A takes none.
  f.demand(4);
  await f.pass();
  assert.deepEqual(await callable(f.state), ["slot-b", "slot-c", "slot-d"]);
  f.crash("slot-c");
  await f.until("slot-c", "quarantined");
  assert.deepEqual(await callable(f.state), ["slot-b", "slot-d"]);
  for (const slot of ["slot-b", "slot-d"]) assert.equal(f.listed(slot), "running");
});

/** `passes` upkeep passes, each checking that `slot` holds `wanted` and that no row is quarantined. */
async function holds(
  f: Awaited<ReturnType<typeof stoppingFleet>>,
  slot: string,
  wanted: string,
  passes: number,
) {
  for (let index = 0; index < passes; index++) {
    await f.pass();
    assert.equal(await f.phase(slot), wanted, `${slot} at pass ${index}`);
    const held = (await f.state.inspect()).filter((row) => row.phase === "quarantined");
    assert.deepEqual(
      held.map((row) => row.target.slotId),
      [],
      `quarantined at pass ${index}`,
    );
  }
}

test("a retirement that begins while another cell stops waits draining, so neither stop ends in quarantine", async (context) => {
  const f = await stoppingFleet(context);
  f.demand(4);
  await f.pass();
  f.letIdle("slot-a");
  f.demand(3);
  await f.until("slot-a", "retiring");
  // B idles out while A still stops: its retirement waits in draining, which has no time bound,
  // rather than in retiring, whose bound A's stop would outlast.
  f.letIdle("slot-b");
  f.demand(2);
  await holds(f, "slot-b", "draining", 30);
  assert.equal(f.listed("slot-b"), "running");
  assert.equal(await f.phase("slot-a"), "retiring");
  f.endStop("slot-a");
  await f.pass();
  assert.equal(await f.phase("slot-a"), undefined);
  await f.until("slot-b", "retiring");
  f.endStop("slot-b");
  await f.pass();
  assert.equal(await f.phase("slot-b"), undefined);
  assert.deepEqual(await f.ends(), { "slot-a": "retired", "slot-b": "retired" });
  assert.equal(f.peak(), 4);
});

test("a retirement that begins while another cell still starts waits draining until it runs", async (context) => {
  const f = await stoppingFleet(context);
  f.demand(3);
  await f.pass();
  // D's start is slow; A idles out while it boots.
  f.slowStart("slot-d");
  f.demand(4);
  await f.pass();
  assert.equal(f.listed("slot-d"), "provisioning");
  f.letIdle("slot-a");
  await holds(f, "slot-a", "draining", 40);
  assert.equal(f.listed("slot-a"), "running");
  f.boot("slot-d");
  await f.until("slot-d", "ready");
  await f.until("slot-a", "retiring");
  f.endStop("slot-a");
  await f.pass();
  assert.equal(await f.phase("slot-a"), undefined);
  assert.deepEqual(await f.ends(), { "slot-a": "retired" });
  assert.equal(f.peak(), 4);
});
