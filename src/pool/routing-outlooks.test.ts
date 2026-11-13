import assert from "node:assert/strict";
import { test } from "node:test";
import { routingOutlooks } from "./routing-outlooks.ts";
import type { CapacityOutlookInput } from "./routing-attention.ts";
import { capacityOutlook } from "./routing-outlook-view.ts";

const now = Date.UTC(2026, 10, 13),
  day = 86400_000;
const input: CapacityOutlookInput = {
  provider: "claude",
  modelFamily: null,
  from: new Date(now).toISOString(),
  through: new Date(now + 7 * day).toISOString(),
  status: "needs-more-accounts",
  evidence: {
    source: "history-forecast",
    status: "calibrated",
    confidence: "medium",
    revision: "test",
    calculatedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 3600_000).toISOString(),
    historyFrom: new Date(now - 30 * day).toISOString(),
    historyThrough: new Date(now).toISOString(),
    coverageRatio: 1,
    heldOutPeriods: 2,
    backtestRelativeError: 0.1,
    unit: { id: "weekly", label: "weekly", calibrationRevision: "test" },
    reasons: [],
  },
  scenarios: [
    {
      demand: "median",
      configuredUnserved: 1,
      feasibleUnserved: 1,
      expiringUnused: 0,
      firstShortfallAt: new Date(now + 2 * day).toISOString(),
      bottleneck: "weekly",
    },
  ],
  recommendation: null,
};

test("a missing forecast keeps the episode but requires fresh confirmation before another nudge", async () => {
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
  const first = (await routingOutlooks(storage, "pool", [input], now))[0]!;
  const confirmed = (await routingOutlooks(storage, "pool", [input], now + 5 * 60_000))[0]!;
  assert.equal(confirmed.attention.inboxNudge, "eligible");
  await routingOutlooks(storage, "pool", [], now + 10 * 60_000);
  const recovered = (await routingOutlooks(storage, "pool", [input], now + 15 * 60_000))[0]!;
  assert.equal(recovered.attention.episode, first.attention.episode);
  assert.equal(recovered.attention.inboxNudge, "none");
  const next = (await routingOutlooks(storage, "pool", [input], now + 20 * 60_000))[0]!;
  assert.equal(next.attention.inboxNudge, "eligible");
  assert.equal(next.attention.episode, first.attention.episode);
  const projected = capacityOutlook({ ...next, privateExtension: "secret-extension" });
  assert.equal(projected.modelFamily, null);
  assert.ok(!JSON.stringify(projected).includes("secret-extension"));
  await routingOutlooks(
    storage,
    "pool",
    [{ ...input, status: "enough", scenarios: [] }],
    now + 25 * 60_000,
  );
  const restarted = (await routingOutlooks(storage, "pool", [input], now + 30 * 60_000))[0]!;
  assert.notEqual(restarted.attention.episode, first.attention.episode);
});
