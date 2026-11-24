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
    planMs: 812.04,
    recountPosition: { pool: "0123456789abcdef", block: "2026-08-01T00:00:00Z", host: "x" },
    split: [{ pool: "0123456789abcdef", from: "2026-08-01T00:00:00Z", to: "x" }],
    slow: [
      { pool: "0123456789abcdef", hour: "2026-08-01T03:00:00Z", count: 3, until: "x" },
      {
        pool: "0123456789abcdef",
        hour: "2026-08-01T05:00:00Z",
        count: 1,
        until: "2026-11-23T09:40:00.000Z",
      },
      { pool: "fedcba9876543210", hour: "Pool-name 03:00", count: 1, until: "x" },
    ],
    lastSlow: [
      {
        pool: "0123456789abcdef",
        at: "2026-11-23T09:30:00.000Z",
        hour: "2026-08-01T05:00:00Z",
        block: "2026-08-01T00:00:00Z",
        limit: "count",
        elapsedMs: 1_002.04,
        repeat: 1,
      },
      { pool: "fedcba9876543210", hour: "x", limit: "drop", elapsedMs: -1 },
    ],
    byPool: [
      { pool: "fedcba9876543210", pendingBlocks: 1, pendingHours: 2 },
      { pool: "0123456789abcdef", pendingBlocks: 15, pendingHours: 94 },
      { pool: "fixture-pool-name", pendingBlocks: 1, pendingHours: 1 },
    ],
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
    planMs: 812,
    recountPosition: { pool: "0123456789abcdef", block: "2026-08-01T00:00:00Z" },
    // Each pool by its place in the order of its id, never the id; a pool name never passes.
    byPool: [
      {
        ordinal: 1,
        pendingBlocks: 15,
        pendingHours: 94,
        slow: [
          { hour: "2026-08-01T03:00:00Z", until: null, repeat: 3 },
          { hour: "2026-08-01T05:00:00Z", until: "2026-11-23T09:40:00.000Z", repeat: 1 },
        ],
        lastSlow: {
          at: "2026-11-23T09:30:00.000Z",
          hour: "2026-08-01T05:00:00Z",
          block: "2026-08-01T00:00:00Z",
          limit: "count",
          elapsedMs: 1_002,
          repeat: 1,
        },
      },
      // Free text in a last slow stop names none of it.
      { ordinal: 2, pendingBlocks: 1, pendingHours: 2, slow: [], lastSlow: null },
    ],
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
      planMs: "fast",
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
      planMs: null,
      recountPosition: null,
      byPool: [],
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
