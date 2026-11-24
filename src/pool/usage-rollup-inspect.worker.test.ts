import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { usagePeopleRollupAutoKey, usageRollupAutoKey } from "./model-history/usage-rollup-auto.ts";
import { captureHoursAutoKey } from "./model-history/capture-hours-auto.ts";

test("the controller's inspect carries the usage rollup's stored state without a database read", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const f = await fleetWorkerFixture();
  t.after(f.cleanup);
  await f.bootstrap();
  // This object has no history database binding: any database read would fail the field to null.
  await f.old.storage.put(usageRollupAutoKey, {
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "budget",
    pools: 1,
    pendingHours: 2_832,
    sessions: [{ at: 1, ms: 24_000, walBytes: 1_000 }],
    stuck: [{ pool: "0123456789abcdef", reason: "slow", retryAt: "2026-11-24T09:30:00.000Z" }],
  });
  const inspected = (await f.send("inspect")) as { usageRollup?: unknown; digest?: unknown };
  assert.equal(
    typeof inspected.digest,
    "string",
    "the inspect release flows rely on still answers",
  );
  assert.deepEqual(inspected.usageRollup, {
    rollup: "v15",
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "budget",
    pausedUntil: null,
    lastHour: null,
    lastHourPhase: null,
    lastHourReadMs: null,
    pools: 1,
    pendingHours: 2_832,
    totalPendingHours: null,
    stuck: [
      { pool: "0123456789abcdef", reason: "slow", hour: null, retryAt: "2026-11-24T09:30:00.000Z" },
    ],
  });
  // Once a tick found v16 applied, inspect shows v16's own state, not v15's.
  await f.old.storage.put(usagePeopleRollupAutoKey, {
    rollup: "v16",
    lastTickAt: "2026-11-23T10:30:00.000Z",
    lastStop: "complete",
    pools: 0,
    pendingHours: 0,
  });
  const people = (await f.send("inspect")) as { usageRollup?: unknown };
  assert.deepEqual(people.usageRollup, {
    rollup: "v16",
    lastTickAt: "2026-11-23T10:30:00.000Z",
    lastStop: "complete",
    pausedUntil: null,
    lastHour: null,
    lastHourPhase: null,
    lastHourReadMs: null,
    pools: 0,
    pendingHours: 0,
    totalPendingHours: null,
    stuck: [],
  });
});

test("the controller's inspect carries the capture-hour counts' stored state beside the rollup's", async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const f = await fleetWorkerFixture();
  t.after(f.cleanup);
  await f.bootstrap();
  const before = (await f.send("inspect")) as { captureHours?: unknown };
  assert.deepEqual(before.captureHours, {
    lastTickAt: null,
    lastStop: null,
    pausedUntil: null,
    pools: null,
    pendingBlocks: null,
    pendingHours: null,
    stuck: [],
    lastHour: null,
    lastHourReadMs: null,
    stalestCheckedAt: null,
    planMs: null,
    recountPosition: null,
  });
  await f.old.storage.put(captureHoursAutoKey, {
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "slow",
    lastHour: "2026-11-01T03:00:00Z",
    lastHourReadMs: 1_000,
    pools: 1,
    pendingBlocks: 2,
    pendingHours: 12,
    stalestCheckedAt: "2026-11-20T01:00:00.000Z",
    recountPosition: { pool: "0123456789abcdef", block: "2026-11-01T00:00:00Z" },
    split: [{ pool: "0123456789abcdef", from: "2026-11-01T00:00:00Z", to: "2026-11-01T06:00:00Z" }],
    nextPool: "0123456789abcdef",
    planMs: 31.2,
    sessions: [{ at: 1, ms: 12_000 }],
    stuck: [
      {
        pool: "0123456789abcdef",
        reason: "slow",
        hour: "2026-11-01T03:00:00Z",
        retryAt: "2026-11-23T09:40:00.000Z",
      },
    ],
  });
  const inspected = (await f.send("inspect")) as { captureHours?: unknown; digest?: unknown };
  assert.equal(typeof inspected.digest, "string");
  assert.deepEqual(inspected.captureHours, {
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "slow",
    pausedUntil: null,
    pools: 1,
    pendingBlocks: 2,
    pendingHours: 12,
    stuck: [
      {
        pool: "0123456789abcdef",
        reason: "slow",
        hour: "2026-11-01T03:00:00Z",
        retryAt: "2026-11-23T09:40:00.000Z",
      },
    ],
    lastHour: "2026-11-01T03:00:00Z",
    lastHourReadMs: 1_000,
    stalestCheckedAt: "2026-11-20T01:00:00.000Z",
    planMs: 31.2,
    recountPosition: { pool: "0123456789abcdef", block: "2026-11-01T00:00:00Z" },
  });
});
