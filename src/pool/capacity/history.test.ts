import assert from "node:assert/strict";
import { test } from "node:test";
import { CapacityHistory, type CapacityExpectedCohort } from "./history.ts";
import type { CapacityReading } from "./normalize.ts";
import { ChunkStorage, type UsageStorage } from "../usage-storage.ts";

class Memory implements UsageStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { this.values.delete(key); }
}

const hour = 3_600_000;
const start = Date.parse("2026-11-03T10:05:00Z");
const expected = (accounts: number): CapacityExpectedCohort[] => [{ provider: "claude", windowSeconds: 18_000, accounts }];

function reading(account: string, remaining: number, options: Partial<CapacityReading> = {}): CapacityReading {
  const base: CapacityReading = {
    account, provider: "claude", plan: "Pro", windowSeconds: 18_000, mode: "rolling",
    observedAt: start - 60_000, resetAt: null, staleAt: null, observationSource: "fixture",
    full: 5, remaining, unit: { id: "claude-pro-equivalent", label: "Pro-eq" }, source: "reference-plan",
    knownWeight: true, revision: "r1",
  };
  return { ...base, ...options };
}

test("hourly totals keep weighted minimum and last with per-plan source-time ranges and no account IDs", async () => {
  const storage = new Memory(), history = new CapacityHistory(storage);
  const firstAt = start, minimumAt = start + 5 * 60_000, lastAt = start + 10 * 60_000;
  await history.observe("pool-a", { at: firstAt, expected: expected(2), readings: [
    reading("private-account-a", 2, { observedAt: firstAt - 30_000 }),
    reading("private-account-b", 10, { plan: "Max 20x", full: 20, remaining: 10, observedAt: firstAt - 10_000,
      source: "published-session-multiplier", revision: "session-v1" }),
  ] });
  await history.observe("pool-a", { at: minimumAt, expected: expected(2), readings: [
    reading("private-account-a", 1, { observedAt: minimumAt - 20_000 }),
    reading("private-account-b", 8, { plan: "Max 20x", full: 20, remaining: 8, observedAt: minimumAt - 5_000,
      source: "published-session-multiplier", revision: "session-v1" }),
  ] });
  await history.observe("pool-a", { at: lastAt, expected: expected(2), readings: [
    reading("private-account-a", 4, { observedAt: lastAt - 40_000 }),
    reading("private-account-b", 11, { plan: "Max 20x", full: 20, remaining: 11, observedAt: lastAt - 2_000,
      source: "published-session-multiplier", revision: "session-v1" }),
  ] });

  const points = await history.read("pool-a");
  assert.equal(points.length, 1);
  const point = points[0]!;
  assert.equal(point.hour, Date.parse("2026-11-03T10:00:00Z"));
  assert.deepEqual(point.minimum, {
    remaining: 9, full: 25, at: minimumAt, observedAt: { from: minimumAt - 20_000, to: minimumAt - 5_000 },
    accountCount: 2, knownWeightCount: 2, unknownWeightCount: 0,
    weights: [
      { source: "published-session-multiplier", revision: "session-v1", accountCount: 1 },
      { source: "reference-plan", revision: "r1", accountCount: 1 },
    ],
  });
  assert.deepEqual(point.last, {
    remaining: 15, full: 25, at: lastAt, observedAt: { from: lastAt - 40_000, to: lastAt - 2_000 },
    accountCount: 2, knownWeightCount: 2, unknownWeightCount: 0,
    weights: [
      { source: "published-session-multiplier", revision: "session-v1", accountCount: 1 },
      { source: "reference-plan", revision: "r1", accountCount: 1 },
    ],
  });
  assert.deepEqual(point.plans.map(({ plan, minimum, last }) => [plan, minimum.remaining, last?.remaining]), [
    ["Max 20x", 8, 11], ["Pro", 1, 4],
  ]);
  assert.equal(JSON.stringify(points).includes("private-account"), false);
  assert.equal(JSON.stringify([...storage.values]).includes("private-account"), false);
});

test("mixed units validate provider/window cohort coverage before storing separate groups", async () => {
  const history = new CapacityHistory(new Memory());
  const absolute = reading("private-account-b", 70, {
    full: 100, remaining: 70, unit: { id: "credits-usd", label: "credits (USD)" }, source: "reported-absolute", knownWeight: true,
  });
  const first = await history.observe("pool-a", {
    at: start, expected: expected(2),
    readings: [reading("private-account-a", 3, { plan: "Mystery", source: "unknown-plan", knownWeight: false }), absolute],
  });
  assert.deepEqual(first, { accepted: true, groups: 2, incomplete: 0 });
  const points = await history.read("pool-a");
  assert.equal(points.length, 2);
  assert.deepEqual(points.map((point) => point.last.accountCount).sort(), [1, 1]);
  assert.equal(points.find((point) => point.unit.id === "claude-pro-equivalent")?.last.unknownWeightCount, 1);
  assert.deepEqual(points.find((point) => point.unit.id === "credits-usd")?.last.weights, [
    { source: "reported-absolute", revision: "r1", accountCount: 1 },
  ]);

  const missing = await history.observe("pool-a", {
    at: start + hour, expected: expected(2), readings: [reading("private-account-a", 0, { observedAt: start + hour - 1 })],
  });
  assert.deepEqual(missing, { accepted: true, groups: 0, incomplete: 1 });
  assert.equal((await history.read("pool-a")).length, 2);

  const duplicateAccount = await history.observe("pool-a", {
    at: start + 2 * hour, expected: expected(1), readings: [
      reading("private-account-a", 2, { observedAt: start + 2 * hour - 1 }),
      reading("private-account-a", 90, { full: 100, remaining: 90, unit: { id: "credits-usd", label: "credits (USD)" }, source: "reported-absolute", observedAt: start + 2 * hour - 1 }),
    ],
  });
  assert.deepEqual(duplicateAccount, { accepted: true, groups: 2, incomplete: 0 });
  assert.equal((await history.read("pool-a")).length, 4);
});

test("unchanged source observations are deduplicated and older snapshots are rejected", async () => {
  const history = new CapacityHistory(new Memory()), sample = reading("private-account-a", 2);
  assert.deepEqual(await history.observe("pool-a", { at: start, expected: expected(1), readings: [sample] }), {
    accepted: true, groups: 1, incomplete: 0,
  });
  assert.deepEqual(await history.observe("pool-a", { at: start + 5 * 60_000, expected: expected(1), readings: [sample] }), {
    accepted: true, groups: 0, incomplete: 0,
  });
  assert.deepEqual(await history.observe("pool-a", { at: start + 2 * 60_000, expected: expected(1), readings: [sample] }), {
    accepted: false, groups: 0, incomplete: 0,
  });
  const points = await history.read("pool-a");
  assert.equal(points.length, 1);
  assert.equal(points[0]!.last.at, start);
});

test("weight policy changes append frozen values without rewriting earlier hours", async () => {
  const history = new CapacityHistory(new Memory()), firstAt = start, secondAt = start + hour;
  await history.observe("pool-a", { at: firstAt, expected: expected(1), readings: [reading("private-account-a", 2)] });
  await history.observe("pool-a", { at: secondAt, expected: expected(1), readings: [reading("private-account-a", 4, {
    observedAt: secondAt - 60_000, full: 7, revision: "r2", source: "published-session-multiplier",
  })] });
  const points = await history.read("pool-a");
  assert.equal(points.length, 2);
  assert.equal(points[0]!.last.full, 5);
  assert.equal(points[0]!.last.remaining, 2);
  assert.equal(points[1]!.last.full, 7);
  assert.equal(points[1]!.last.remaining, 4);
});

test("history is partitioned by day and pruned to 400 rolling days", async () => {
  const storage = new Memory(), history = new CapacityHistory(storage);
  const firstAt = Date.parse("2025-01-01T10:00:00Z"), latestAt = firstAt + 400 * 24 * hour;
  await history.observe("pool-a", { at: firstAt, expected: expected(1), readings: [reading("private-account-a", 2, { observedAt: firstAt - 1 })] });
  await history.observe("pool-a", { at: latestAt, expected: expected(1), readings: [reading("private-account-a", 1, { observedAt: latestAt - 1 })] });

  const points = await history.read("pool-a");
  assert.equal(points.length, 1);
  assert.equal(points[0]!.hour, latestAt);
  const index = await new ChunkStorage(storage).get<{ days: string[]; fromHour: number }>("capacity-v1:pool-a:index");
  assert.deepEqual(index?.days, [new Date(latestAt).toISOString().slice(0, 10)]);
  assert.equal(index?.fromHour, latestAt - (400 * 24 - 1) * hour);
  assert.equal([...storage.values.keys()].filter((key) => key.includes(":day:")).length, 1);
});
