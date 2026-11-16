import assert from "node:assert/strict";
import { test } from "node:test";
import { readinessHold, type RealReadyObservation } from "./readiness-hold.ts";
import {
  policyHealthHeader,
  launchGenerationHeader,
  launchTokenHashHeader,
} from "../../../src/pool/runtime-health.ts";
import { RuntimeActivity } from "../../../src/pool/runtime-slots/activity.ts";
import { SlotMemory } from "../../pool-tests/runtime-slot-storage.ts";

function fixture() {
  let now = 100,
    calls = 0,
    boot = "real-boot",
    status = 200;
  const input = { runtimeName: "scratch-blue-1", attempt: "attempt-1", deadline: 90_100 };
  const recorded: RealReadyObservation[] = [];
  const gate = readinessHold(input, {
    now: () => now,
    record: (observation) => recorded.push(observation),
  });
  const container = {
    identity: "real-container",
    getTcpPort: (number: number) => ({
      fetch: async (request: string | Request, init?: RequestInit) => {
        assert.equal(number, 8318);
        const value = new Request(request, init);
        assert.equal(value.headers.get("Authorization"), "Bearer fixture-only");
        calls++;
        return Response.json(
          { boot_id: boot, started_at: "native-start" },
          {
            status,
            headers: {
              [policyHealthHeader]: String(1500 - calls),
              [launchGenerationHeader]: "3",
              [launchTokenHashHeader]: "a".repeat(64),
            },
          },
        );
      },
    }),
  };
  const ctx = {
    container,
    getIdentity() {
      return this.container.identity;
    },
  };
  const adapted = gate.wrapContext(ctx);
  const probe = () =>
    adapted.container
      .getTcpPort(8318)
      .fetch("http://pool/ready", { headers: { Authorization: "Bearer fixture-only" } });
  return {
    gate,
    input,
    recorded,
    adapted,
    probe,
    calls: () => calls,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    reboot: () => {
      boot = "another-boot";
    },
    fail: () => {
      status = 503;
    },
  };
}

test("a hold suppresses only positive real probes and release reads a fresh body and lease", async () => {
  const f = fixture();
  assert.equal((await f.probe()).status, 503);
  assert.equal((await f.probe()).status, 503);
  assert.equal(f.calls(), 2);
  assert.equal(f.adapted.getIdentity(), "real-container");
  assert.equal(f.recorded[0]!.body, '{"boot_id":"real-boot","started_at":"native-start"}');
  assert.deepEqual(
    f.recorded.map((entry) => [
      entry.disposition,
      entry.bootId,
      entry.generation,
      entry.tokenHash,
      entry.leaseMs,
    ]),
    [
      ["held", "real-boot", 3, "a".repeat(64), 1499],
      ["held", "real-boot", 3, "a".repeat(64), 1498],
    ],
  );
  f.advance(60_000);
  f.gate.release(f.input);
  const released = await f.probe();
  assert.equal(released.status, 200);
  assert.equal(released.headers.get(policyHealthHeader), "1497");
  assert.equal(f.calls(), 3);
  assert.equal(f.recorded[2]!.disposition, "released");
  assert.equal(f.recorded[2]!.positive, true);
});

test("foreign release, changed boot, over-budget hold and a mutated deadline cannot extend the gate", async () => {
  const f = fixture();
  assert.throws(() => f.gate.release(f.input), /positively observed/);
  await f.probe();
  assert.throws(() => f.gate.release({ ...f.input, attempt: "foreign" }), /another scratch/);
  f.input.deadline = 1_000_000;
  f.advance(90_000);
  assert.equal((await f.probe()).status, 200);
  assert.equal(f.gate.inspect(f.input).disposition, "expired");
  assert.throws(() => f.gate.release(f.input), /unexpired hold/);
  assert.throws(
    () => readinessHold({ ...f.input, deadline: Date.now() + 180_000 }, { record: () => {} }),
    /startup budget/,
  );
  const other = fixture();
  await other.probe();
  other.reboot();
  await assert.rejects(other.probe(), /changed runtime incarnation/);
  other.gate.close();
  assert.equal((await other.probe()).status, 200);
});

test("a real refusal is retained and never turned into a positive or released observation", async () => {
  const f = fixture();
  f.fail();
  assert.equal((await f.probe()).status, 503);
  assert.equal(f.recorded[0]!.status, 503);
  assert.equal(f.recorded[0]!.positive, false);
  assert.equal(f.recorded[0]!.body, '{"boot_id":"real-boot","started_at":"native-start"}');
  assert.equal(f.gate.inspect(f.input).positives, 0);
  assert.throws(() => f.gate.release(f.input), /positively observed/);
});

test("endpoint inspection reads the actual durable draining count without mutating it", async () => {
  const storage = new SlotMemory();
  const activity = new RuntimeActivity(storage);
  const identity = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "root",
    slotId: "slot",
    applicationId: "blue",
    applicationVersion: "1",
    instanceId: "instance",
    imageDigest: `sha256:${"b".repeat(64)}`,
    imageInput: "input",
    bootId: "boot",
  };
  await activity.initialize(identity, true);
  const done = await activity.acquire(identity);
  await activity.drain(identity);
  const before = await activity.inspect(identity);
  assert.equal(before?.phase, "draining");
  assert.equal(before?.active, 1);
  assert.deepEqual(await activity.inspect(identity), before);
  await assert.rejects(activity.acquire(identity), /draining/);
  await done();
  assert.equal((await activity.inspect(identity))?.active, 0);
});
