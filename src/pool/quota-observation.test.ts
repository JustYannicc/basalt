import test from "node:test";
import assert from "node:assert/strict";
import { quotaObservation } from "./quota-observation.ts";

test("quota observations keep only reported windows and preserve raw periods, scopes and amounts", () => {
  const raw = { id: "custom-weekly", label: null, scope: "model", scope_id: "coding", mode: "rolling",
    unit: "percentage", used: 115, remaining: -15, limit: 100, used_ratio: 1.15, remaining_ratio: 0,
    is_unlimited: false, window_seconds: 604800, period_unit: "week", period_value: 1,
    period: { mode: "provider-defined", future_field: ["value"] }, observed_at: "2026-10-30T18:00:00Z", future_field: { retained: true } };
  const result = quotaObservation({ credential: { plan: { name: "Pro 20x", premium: true }, primary_windows: [] }, windows: [raw] });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]?.used, 115);
  assert.equal(result.windows[0]?.remaining, -15);
  assert.equal(result.windows[0]?.limit, 100);
  assert.equal(result.windows[0]?.scopeId, "coding");
  assert.deepEqual(result.windows[0]?.raw, raw);
  assert.deepEqual(result.windows[0]?.period.raw, raw.period);
  assert.equal(result.windows[0]?.period.mode, "provider-defined");
  assert.deepEqual(result.plan, { name: "Pro 20x", premium: true, rawTier: null, raw: { name: "Pro 20x", premium: true } });
  raw.period.future_field.push("changed");
  assert.deepEqual(result.windows[0]?.period.raw, { mode: "provider-defined", future_field: ["value"] });
});

test("empty and unknown periods never invent a five-hour window, a mode, quantities or a tier", () => {
  const empty = quotaObservation({ credential: { plan: { name: "Pro", premium: true } }, windows: [] });
  assert.deepEqual(empty.windows, []);
  const result = quotaObservation({ credential: {}, windows: [{ id: "duration-only", window_seconds: 18000 }] });
  assert.equal(result.windows[0]?.period.mode, null);
  assert.equal(result.windows[0]?.used, null);
  assert.equal(result.windows[0]?.remainingRatio, null);
  assert.equal(result.windows[0]?.unit, null);
  assert.equal(result.plan, null);
});

test("each reading retains its source time and a failed attempt never replaces it with check time", () => {
  const result = quotaObservation({ credential: { observed_at: "2026-10-30T18:00:00Z" },
    collection: { status: "failed", freshness: "stale", observed_at: "2026-10-30T18:00:00Z",
      last_attempt_at: "2026-10-30T18:45:00Z", next_probe_at: "2026-10-30T19:15:00Z", error: { code: "UPSTREAM_RATE_LIMITED", message: "private diagnostic" } },
    windows: [{ id: "weekly", observed_at: "2026-10-30T17:59:00Z", limit: 100 }],
    reset_credits: { available_count: 2, credits: [{ id: "credit", status: "available", expires_at: "2026-11-01T00:00:00Z" }] } });
  assert.equal(result.observedAt, "2026-10-30T18:00:00Z");
  assert.equal(result.windows[0]?.observedAt, "2026-10-30T17:59:00Z");
  assert.equal(result.collection.status, "failed");
  assert.equal(result.collection.errorCode, "UPSTREAM_RATE_LIMITED");
  assert.ok(!JSON.stringify(result.collection).includes("private diagnostic"));
  assert.equal(result.resets?.available, 2);
});

test("the public observation carries reported quantities and expiry without raw Home detail", async () => {
  const { publicQuotaObservation } = await import("./quota-observation-public.ts");
  const at = "2026-10-30T18:00:00Z";
  const output = publicQuotaObservation(quotaObservation({
    credential: { credential_id: "private-credential-id", plan: { name: "Pro", premium: true, diagnostic: "private-detail" } },
    windows: [{ id: "weekly", label: "Weekly", scope: "model", scope_id: "coding", unit: "requests",
      used: 120, remaining: -20, limit: 100, remaining_ratio: 0, mode: "rolling", window_seconds: 604800, observed_at: at,
      diagnostic: "private-detail" }],
    collection: { status: "failed", observed_at: at, last_attempt_at: "2026-10-30T18:45:00Z", error: { code: "UPSTREAM_RATE_LIMITED", message: "private-detail" } },
    reset_credits: { available_count: 2, observed_at: at, credits: [
      { id: "private-credit-id", status: "available", expires_at: "2026-11-01T00:00:00Z" },
      { id: "private-credit-id-2", status: "available", expires_at: null },
    ] },
  }));
  assert.equal(output?.observedAt, "2026-10-30T18:00:00.000Z");
  assert.equal(output?.observation.windows[0]?.measure.remaining, -20);
  assert.equal(output?.observation.windows[0]?.measure.limit, 100);
  assert.equal(output?.observation.windows[0]?.period?.mode, "rolling");
  assert.equal(output?.collection?.outcome, "rate_limited");
  assert.equal(output?.observation.balances.reduce((total, balance) => total + balance.available, 0), 2);
  assert.equal(output?.observation.balances.filter((balance) => balance.expiresAt).length, 1);
  assert.ok(!JSON.stringify(output).includes("private-"));
  const empty = publicQuotaObservation(quotaObservation({ credential: { plan: { name: "Pro" } }, windows: [], collection: { observed_at: at } }));
  assert.deepEqual(empty?.observation.windows, []);
  assert.equal(publicQuotaObservation(quotaObservation({ windows: [] })), null);
});
