import assert from "node:assert/strict";
import { test } from "node:test";
import { usageCredits, retainedUsageCredits } from "./usage-credits.ts";
import { publicQuotaObservation } from "./quota-observation-public.ts";
import { quotaObservation } from "./quota-observation.ts";

test("credit facts retain units, enablement and independent source freshness", () => {
  const at = "2026-11-01T10:00:00.000Z",
    expiry = "2026-11-01T10:30:00.000Z";
  const value = usageCredits(
    {
      state: "available",
      balance: "1250.50",
      observed_at: at,
      expires_at: expiry,
      arbitrary: "private",
    },
    Date.parse(at),
  );
  assert.ok(value);
  assert.deepEqual(value.balance, { value: "1250.50", unit: "credits" });
  assert.equal(value.freshness, "fresh");
  assert.equal(retainedUsageCredits(value, Date.parse(expiry)).freshness, "stale");
  assert.equal(JSON.stringify(value).includes("private"), false);
  const extra = usageCredits(
    {
      state: "unknown",
      observed_at: at,
      expires_at: expiry,
      extra_usage: { enabled: true, monthly_cap: "unlimited", used_ratio: 0.4, cap: 100 },
    },
    Date.parse(at),
  );
  assert.equal(extra?.state, "unknown");
  assert.equal(extra?.balance, null);
  assert.deepEqual(extra?.extraUsage, {
    enabled: true,
    monthlyCap: "unlimited",
    usedRatio: 0.4,
    spent: null,
    cap: null,
  });
  for (const balance of ["-1", "NaN", "Infinity", "1e50", 25])
    assert.equal(usageCredits({ state: "available", balance })?.state, "unknown");
});

test("publishing credits preserves the fact object and never adds them to banked resets", () => {
  const detail = {
    credential: { observed_at: "2026-11-01T10:00:00Z", expires_at: "2026-11-01T10:30:00Z" },
    windows: [],
    usage_credits: {
      state: "unlimited",
      balance: null,
      observed_at: "2026-11-01T10:00:00Z",
      expires_at: "2026-11-01T10:30:00Z",
    },
  };
  const value = publicQuotaObservation(quotaObservation(detail));
  assert.equal(value?.observation.usageCredits?.state, "unlimited");
  assert.deepEqual(value?.observation.balances, []);
  assert.equal(value?.observation.usageCredits?.balance, null);
});
