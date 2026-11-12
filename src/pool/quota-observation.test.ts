import test from "node:test";
import assert from "node:assert/strict";
import { quotaObservation } from "./quota-observation.ts";

test("reported fixed periods normalize without guessing missing or calendar durations", () => {
  const windows = quotaObservation({
    windows: [
      { period_unit: "week", period_value: 1 },
      { period_unit: "hour", period_value: 5 },
      { period_unit: "day", period_value: 7 },
      { window_seconds: 18000, period_unit: "week", period_value: 1 },
      { period_unit: "month", period_value: 1 },
      { label: "Weekly", reset_at: "2026-11-16T00:00:00Z" },
      { period_unit: "week", period_value: 0 },
      { period_unit: "week", period_value: -1 },
      { window_seconds: -1, period_unit: "week", period_value: 1 },
      { period_unit: "week", period_value: "1" },
    ],
  }).windows;
  assert.deepEqual(
    windows.map((window) => window.period.seconds),
    [604800, 18000, 604800, 18000, null, null, null, null, null, null],
  );
});

test("quota observations keep only reported windows and preserve raw periods, scopes and amounts", () => {
  const raw = {
    id: "custom-weekly",
    label: null,
    scope: "model",
    scope_id: "coding",
    mode: "rolling",
    unit: "percentage",
    used: 115,
    remaining: -15,
    limit: 100,
    used_ratio: 1.15,
    remaining_ratio: 0,
    is_unlimited: false,
    window_seconds: 604800,
    period_unit: "week",
    period_value: 1,
    period: { mode: "provider-defined", future_field: ["value"] },
    observed_at: "2026-10-30T18:00:00Z",
    future_field: { retained: true },
  };
  const result = quotaObservation({
    credential: { plan: { name: "Pro 20x", premium: true }, primary_windows: [] },
    windows: [raw],
  });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]?.used, 115);
  assert.equal(result.windows[0]?.remaining, -15);
  assert.equal(result.windows[0]?.limit, 100);
  assert.equal(result.windows[0]?.scopeId, "coding");
  assert.deepEqual(result.windows[0]?.raw, raw);
  assert.deepEqual(result.windows[0]?.period.raw, raw.period);
  assert.equal(result.windows[0]?.period.mode, "provider-defined");
  assert.deepEqual(result.plan, {
    name: "Pro 20x",
    premium: true,
    rawTier: null,
    raw: { name: "Pro 20x", premium: true },
  });
  raw.period.future_field.push("changed");
  assert.deepEqual(result.windows[0]?.period.raw, {
    mode: "provider-defined",
    future_field: ["value"],
  });
});

test("empty and unknown periods never invent a five-hour window, a mode, quantities or a tier", () => {
  const empty = quotaObservation({
    credential: { plan: { name: "Pro", premium: true } },
    windows: [],
  });
  assert.deepEqual(empty.windows, []);
  const result = quotaObservation({
    credential: {},
    windows: [{ id: "duration-only", window_seconds: 18000 }],
  });
  assert.equal(result.windows[0]?.period.mode, null);
  assert.equal(result.windows[0]?.used, null);
  assert.equal(result.windows[0]?.remainingRatio, null);
  assert.equal(result.windows[0]?.unit, null);
  assert.equal(result.plan, null);
});

test("each reading retains its source time and a failed attempt never replaces it with check time", () => {
  const result = quotaObservation({
    credential: { observed_at: "2026-10-30T18:00:00Z" },
    collection: {
      status: "failed",
      freshness: "stale",
      observed_at: "2026-10-30T18:00:00Z",
      last_attempt_at: "2026-10-30T18:45:00Z",
      next_probe_at: "2026-10-30T19:15:00Z",
      error: { code: "UPSTREAM_RATE_LIMITED", message: "private diagnostic" },
    },
    windows: [{ id: "weekly", observed_at: "2026-10-30T17:59:00Z", limit: 100 }],
    reset_credits: {
      available_count: 2,
      credits: [{ id: "credit", status: "available", expires_at: "2026-11-01T00:00:00Z" }],
    },
  });
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
  const output = publicQuotaObservation(
    quotaObservation({
      credential: {
        credential_id: "private-credential-id",
        plan: { name: "Pro", premium: true, diagnostic: "private-detail" },
      },
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          scope: "model",
          scope_id: "coding",
          unit: "requests",
          used: 120,
          remaining: -20,
          limit: 100,
          remaining_ratio: 0,
          mode: "rolling",
          window_seconds: 604800,
          observed_at: at,
          diagnostic: "private-detail",
        },
      ],
      collection: {
        status: "failed",
        observed_at: at,
        last_attempt_at: "2026-10-30T18:45:00Z",
        error: { code: "UPSTREAM_RATE_LIMITED", message: "private-detail" },
      },
      reset_credits: {
        available_count: 2,
        observed_at: at,
        credits: [
          { id: "private-credit-id", status: "available", expires_at: "2026-11-01T00:00:00Z" },
          { id: "private-credit-id-2", status: "available", expires_at: null },
        ],
      },
    }),
  );
  assert.equal(output?.observedAt, "2026-10-30T18:00:00.000Z");
  assert.equal(
    output?.observation.offering,
    "unknown",
    "a plan and quota do not establish an offering",
  );
  assert.equal(output?.observation.windows[0]?.measure.remaining, -20);
  assert.equal(output?.observation.windows[0]?.measure.limit, 100);
  assert.equal(output?.observation.windows[0]?.period?.mode, "rolling");
  assert.equal(output?.collection?.outcome, "rate_limited");
  assert.equal(
    output?.observation.balances.reduce((total, balance) => total + balance.available, 0),
    2,
  );
  assert.equal(output?.observation.balances.filter((balance) => balance.expiresAt).length, 1);
  assert.ok(!JSON.stringify(output).includes("private-"));
  const empty = publicQuotaObservation(
    quotaObservation({
      credential: { plan: { name: "Pro" } },
      windows: [],
      collection: { observed_at: at },
    }),
  );
  assert.deepEqual(empty?.observation.windows, []);
  assert.equal(publicQuotaObservation(quotaObservation({ windows: [] })), null);
});

test("public freshness follows the collection interval plus two upkeep passes and the publish budget from each source time", async () => {
  const { publicQuotaObservation } = await import("./quota-observation-public.ts");
  const { quotaCollectInterval } = await import("./quota-collection.ts");
  const { poolLifecycle } = await import("./lifecycle.ts");
  const observedAt = "2026-11-03T10:00:00.000Z";
  const windowAt = "2026-11-03T09:59:00.000Z";
  const balanceAt = "2026-11-03T09:58:00.000Z";
  const output = publicQuotaObservation(
    quotaObservation({
      credential: { plan: { name: "Pro" } },
      collection: { observed_at: observedAt },
      windows: [{ id: "weekly", unit: "requests", observed_at: windowAt }],
      reset_credits: { available_count: 2, observed_at: balanceAt, credits: [] },
    }),
  );
  const horizon = (at: string) =>
    new Date(
      Date.parse(at) + quotaCollectInterval + 2 * poolLifecycle.refreshMs + 30_000,
    ).toISOString();
  assert.equal(output?.observation.plan?.staleAt, horizon(observedAt));
  assert.equal(output?.observation.windows[0]?.staleAt, horizon(windowAt));
  assert.equal(output?.observation.balances[0]?.staleAt, horizon(balanceAt));
});

test("public freshness preserves earlier Home deadlines and caps later ones", async () => {
  const { publicQuotaObservation } = await import("./quota-observation-public.ts");
  const observedAt = "2026-11-03T10:00:00.000Z";
  const early = "2026-11-03T10:02:00.000Z";
  const later = "2026-11-03T11:00:00.000Z";
  const detail = {
    credential: { plan: { name: "Pro" } },
    collection: { observed_at: observedAt, expires_at: later },
    windows: [{ id: "weekly", unit: "requests", observed_at: observedAt, expires_at: early }],
    reset_credits: { available_count: 2, observed_at: observedAt, credits: [] },
  };
  const output = publicQuotaObservation(quotaObservation(detail));
  assert.equal(output?.observation.windows[0]?.staleAt, early);
  assert.equal(output?.observation.plan?.staleAt, "2026-11-03T10:40:30.000Z");
  assert.equal(output?.observation.balances[0]?.staleAt, "2026-11-03T10:40:30.000Z");
  detail.collection.expires_at = early;
  detail.windows[0]!.expires_at = later;
  const shortened = publicQuotaObservation(quotaObservation(detail));
  assert.equal(shortened?.observation.windows[0]?.staleAt, early);
  assert.equal(shortened?.observation.plan?.staleAt, early);
  assert.equal(shortened?.observation.balances[0]?.staleAt, early);
});

test("in-progress collection omits a source attempt and retains the successful reading", async () => {
  const { publicQuotaObservation } = await import("./quota-observation-public.ts");
  const { nextObservationState } =
    await import("../../.upstream/packages/sdk/src/implementation/account-observation-state.ts");
  const observedAt = "2026-11-03T10:00:00.000Z";
  const now = Date.parse("2026-11-03T10:31:00.000Z");
  const detail = {
    credential: { plan: { name: "Pro" } },
    collection: { status: "success", observed_at: observedAt, last_attempt_at: observedAt },
    windows: [{ id: "weekly", unit: "requests", remaining: 50, observed_at: observedAt }],
  };
  const previous = publicQuotaObservation(quotaObservation(detail));
  assert.ok(previous);
  const collecting = publicQuotaObservation(
    quotaObservation({
      ...detail,
      collection: {
        ...detail.collection,
        status: "collecting",
        last_attempt_at: new Date(now).toISOString(),
      },
    }),
  );
  assert.ok(collecting);
  assert.equal(collecting.collection, undefined);
  assert.deepEqual(collecting.observation, previous.observation);
  const next = nextObservationState({
    previous: { result: previous },
    result: collecting,
    outcome: "success",
    startedAt: now,
    now,
  });
  assert.equal(next.lastAttempt.outcome, "success");
  assert.deepEqual(next.result?.observation, previous.observation);
});

test("failed collections retain unavailable and rate-limited source attempts", async () => {
  const { publicQuotaObservation } = await import("./quota-observation-public.ts");
  const observedAt = "2026-11-03T10:00:00.000Z";
  const attemptedAt = "2026-11-03T10:31:00.000Z";
  const retryAt = "2026-11-03T11:00:00.000Z";
  for (const [code, outcome] of [
    ["UPSTREAM_RATE_LIMITED", "rate_limited"],
    ["UPSTREAM_UNAVAILABLE", "unavailable"],
  ]) {
    const output = publicQuotaObservation(
      quotaObservation({
        collection: {
          status: "failed",
          observed_at: observedAt,
          last_attempt_at: attemptedAt,
          next_probe_at: retryAt,
          error: { code },
        },
      }),
    );
    assert.deepEqual(output?.collection, { attemptedAt, outcome, retryAt });
  }
});
