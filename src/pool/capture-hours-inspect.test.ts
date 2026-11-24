import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureHoursInspect,
  type CaptureHoursAutoState,
} from "./model-history/capture-hours-auto.ts";

test("the capture-hour counts' inspect is closed: stored fields only, 16-hex pool ids only", () => {
  const state = {
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "slow",
    pausedUntil: "2026-11-23T10:30:00.000Z",
    lastHour: "2026-08-01T03:00:00Z",
    lastHourReadMs: 1_000.04,
    pools: 2,
    pendingBlocks: 16,
    pendingHours: 96,
    stalestCheckedAt: "2026-11-20T01:00:00.123Z",
    recountPosition: { pool: "0123456789abcdef", block: "2026-08-01T00:00:00Z", host: "x" },
    split: [{ pool: "0123456789abcdef", from: "2026-08-01T00:00:00Z", to: "x" }],
    slow: [{ pool: "0123456789abcdef", hour: "2026-08-01T03:00:00Z", count: 3, until: "x" }],
    repeat: { pool: "0123456789abcdef", reason: "lock", count: 2 },
    sessions: [{ at: 1, ms: 2 }],
    stuck: [
      {
        pool: "0123456789abcdef",
        reason: "slow",
        hour: "2026-08-01T03:00:00Z",
        retryAt: "2026-11-24T09:30:00.000Z",
      },
      { pool: "", reason: "error", retryAt: "2026-11-24T09:30:00.000Z" },
      { pool: "fixture-pool-name", reason: "lock", retryAt: "2026-11-24T09:30:00.000Z" },
      { pool: 7, reason: "lock" },
    ],
    host: "private-host.invalid",
  } as unknown as CaptureHoursAutoState;
  assert.deepEqual(captureHoursInspect(state), {
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "slow",
    pausedUntil: "2026-11-23T10:30:00.000Z",
    pools: 2,
    pendingBlocks: 16,
    pendingHours: 96,
    stuck: [
      {
        pool: "0123456789abcdef",
        reason: "slow",
        hour: "2026-08-01T03:00:00Z",
        retryAt: "2026-11-24T09:30:00.000Z",
      },
      { pool: null, reason: "error", hour: null, retryAt: "2026-11-24T09:30:00.000Z" },
    ],
    lastHour: "2026-08-01T03:00:00Z",
    lastHourReadMs: 1_000,
    stalestCheckedAt: "2026-11-20T01:00:00.123Z",
    recountPosition: { pool: "0123456789abcdef", block: "2026-08-01T00:00:00Z" },
  });
  // Free text never passes: a lenient date, an unknown stop or reason, a negative count.
  assert.deepEqual(
    captureHoursInspect({
      lastTickAt: "private-host.invalid 1",
      lastStop: "drop table",
      lastHour: "2026-08-01 03:00 Pool-name",
      stalestCheckedAt: "Tue, 24 Nov 2026 09:30:00 GMT",
      lastHourReadMs: -1,
      pools: -1,
      pendingHours: 1.5,
      pendingBlocks: "3",
      recountPosition: { pool: "fixture-pool-name", block: "2026-08-01T00:00:00Z" },
      stuck: [{ pool: "0123456789abcdef", reason: "drop", retryAt: "soon" }],
    } as unknown as CaptureHoursAutoState),
    {
      lastTickAt: null,
      lastStop: null,
      pausedUntil: null,
      pools: null,
      pendingBlocks: null,
      pendingHours: null,
      stuck: [{ pool: "0123456789abcdef", reason: null, hour: null, retryAt: null }],
      lastHour: null,
      lastHourReadMs: null,
      stalestCheckedAt: null,
      recountPosition: null,
    },
  );
  // A position on a pool id but with free text for its block names nothing.
  assert.equal(
    captureHoursInspect({ recountPosition: { pool: "0123456789abcdef", block: "soon" } })
      .recountPosition,
    null,
  );
  assert.deepEqual(captureHoursInspect({}).stuck, []);
});
