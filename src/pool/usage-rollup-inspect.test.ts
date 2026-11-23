import assert from "node:assert/strict";
import { test } from "node:test";
import {
  usageRollupInspect,
  type UsageRollupAutoState,
} from "./model-history/usage-rollup-auto.ts";

test("the usage rollup's inspect is closed: stored fields only, 16-hex pool ids only", () => {
  const state = {
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "budget",
    pausedUntil: "2026-11-23T10:30:00.000Z",
    pools: 2,
    pendingHours: 96,
    repeat: { pool: "0123456789abcdef", reason: "slow", count: 2 },
    sessions: [{ at: 1, ms: 2, walBytes: 3 }],
    stuck: [
      {
        pool: "0123456789abcdef",
        reason: "slow",
        hour: "2026-08-01T03:00:00.000Z",
        retryAt: "2026-11-24T09:30:00.000Z",
      },
      { pool: "", reason: "error", retryAt: "2026-11-24T09:30:00.000Z" },
      { pool: "fixture-pool-name", reason: "lock", retryAt: "2026-11-24T09:30:00.000Z" },
    ],
    host: "private-host.invalid",
  } as unknown as UsageRollupAutoState;
  assert.deepEqual(usageRollupInspect(state), {
    lastTickAt: "2026-11-23T09:30:00.000Z",
    lastStop: "budget",
    pausedUntil: "2026-11-23T10:30:00.000Z",
    pools: 2,
    pendingHours: 96,
    stuck: [
      {
        pool: "0123456789abcdef",
        reason: "slow",
        hour: "2026-08-01T03:00:00.000Z",
        retryAt: "2026-11-24T09:30:00.000Z",
      },
      { pool: null, reason: "error", hour: null, retryAt: "2026-11-24T09:30:00.000Z" },
    ],
  });
  // A lenient date parse or a non-string pool must not carry anything through.
  assert.deepEqual(
    usageRollupInspect({
      lastTickAt: "private-host.invalid 1",
      pausedUntil: "user@example.com 1",
      stuck: [
        { pool: ["0123456789abcdef"], reason: "slow", retryAt: "2026-11-24T09:30:00.000Z" },
        { pool: 1234567890123456, reason: "slow", retryAt: "2026-11-24T09:30:00.000Z" },
        { pool: "0123456789abcdef", reason: "unheard", hour: "Pool-name 5", retryAt: "x" },
      ],
    } as never),
    {
      lastTickAt: null,
      lastStop: null,
      pausedUntil: null,
      pools: null,
      pendingHours: null,
      stuck: [{ pool: "0123456789abcdef", reason: null, hour: null, retryAt: null }],
    },
  );
  // Anything malformed reads as unknown, never as a value the state did not hold.
  assert.deepEqual(
    usageRollupInspect({ lastStop: "drop table", pools: -1, pendingHours: 1.5 } as never),
    {
      lastTickAt: null,
      lastStop: null,
      pausedUntil: null,
      pools: null,
      pendingHours: null,
      stuck: [],
    },
  );
  assert.deepEqual(usageRollupInspect({}), {
    lastTickAt: null,
    lastStop: null,
    pausedUntil: null,
    pools: null,
    pendingHours: null,
    stuck: [],
  });
});
