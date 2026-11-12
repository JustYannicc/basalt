import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaObservation } from "../quota-observation.ts";
import { capacityReadings } from "./normalize.ts";

const now = Date.parse("2026-11-04T00:00:00Z");

test("Home's xAI account week trains capacity once alongside its product breakdown", () => {
  const weekly = {
    id: "xai-weekly-usage",
    label: "Weekly Limit",
    scope: "account",
    period_unit: "week",
    period_value: 1,
    mode: "fixed",
    status: "healthy",
    unit: "percentage",
    used: 2,
    remaining: 98,
    limit: 100,
    remaining_ratio: 0.98,
    observed_at: new Date(now - 60000).toISOString(),
    reset_at: new Date(now + 4 * 86400000).toISOString(),
  };
  const quota = quotaObservation({
    collection: { status: "success", freshness: "fresh", observed_at: weekly.observed_at },
    credential: { plan: { name: "Grok Pro" } },
    windows: [
      weekly,
      { ...weekly, id: "xai-product-grokchat", scope: "model", scope_id: "grokchat" },
    ],
  });
  const readings = capacityReadings("grok-seat", "xai", quota, now);
  assert.equal(readings.length, 1);
  assert.equal(readings[0]?.windowSeconds, 604800);
  assert.equal(readings[0]?.remaining, 0.98);
  assert.equal(readings[0]?.full, 1);
  assert.equal(readings[0]?.mode, "fixed");
  assert.equal(readings[0]?.resetAt, Date.parse(weekly.reset_at));
  assert.equal(readings[0]?.knownWeight, false);
  assert.deepEqual(
    capacityReadings(
      "grok-seat",
      "xai",
      { ...quota, windows: quota.windows.filter((window) => window.scope === "model") },
      now,
    ),
    [],
  );
});
function observation(overrides: Record<string, unknown> = {}, plan = "Max 5x") {
  return quotaObservation({
    observed_at: new Date(now - 60_000).toISOString(),
    freshness: "fresh",
    collection_status: "success",
    plan: { name: plan },
    primary_windows: [
      {
        id: "claude-five-hour",
        scope: "account",
        window_seconds: 18_000,
        remaining_ratio: 0.4,
        unit: "percentage",
        limit: 100,
        remaining: 40,
        observed_at: new Date(now - 60_000).toISOString(),
        status: "healthy",
        ...overrides,
      },
    ],
  });
}

test("duplicate accounts add distinct weighted contributions and percentage limits are ratios", () => {
  const rows = [
    capacityReadings("a", "claude", observation(), now)[0],
    capacityReadings("b", "claude", observation(), now)[0],
    capacityReadings("c", "claude", observation({ remaining_ratio: 0.25 }, "Max 20x"), now)[0],
  ];
  assert.equal(
    rows.reduce((sum, row) => sum + row.full, 0),
    30,
  );
  assert.equal(
    rows.reduce((sum, row) => sum + row.remaining, 0),
    9,
  );
  assert.equal(rows[0].source, "published-session-multiplier");
});

test("comparable absolute allowance wins and incompatible units stay separate", () => {
  const credits = capacityReadings(
    "a",
    "claude",
    observation({ unit: "credits", limit: 300, remaining: 200 }),
    now,
  )[0];
  assert.equal(credits.full, 300);
  assert.equal(credits.remaining, 200);
  assert.equal(credits.source, "reported-absolute");
  const tokens = capacityReadings(
    "a",
    "claude",
    observation({ unit: "tokens", limit: 300, remaining: 200 }),
    now,
  )[0];
  assert.notEqual(credits.unit.id, tokens.unit.id);
});

test("unknown plans stay flagged and missing or stale observations remain gaps", () => {
  assert.deepEqual(
    capacityReadings("a", "claude", { ...observation(), observedAt: null }, now),
    [],
  );
  assert.deepEqual(
    capacityReadings(
      "a",
      "claude",
      { ...observation(), collection: { ...observation().collection, status: "failed" } },
      now,
    ),
    [],
  );
  const unknown = capacityReadings("a", "claude", observation({}, "Unrecognized tier"), now)[0];
  assert.equal(unknown.knownWeight, false);
  assert.equal(unknown.remaining, 0.4);
  for (const overrides of [
    { remaining_ratio: null },
    { observed_at: null },
    { expires_at: new Date(now).toISOString() },
    { observed_at: new Date(now + 1).toISOString() },
    { status: "failed" },
  ])
    assert.deepEqual(capacityReadings("a", "claude", observation(overrides), now), []);
});

test("model-only and duplicate account windows cannot inflate capacity", () => {
  const quota = observation();
  assert.deepEqual(
    capacityReadings(
      "a",
      "codex",
      observation({ id: "model", scope: "model", scope_id: "codex_code_review" }),
      now,
    ),
    [],
  );
  assert.deepEqual(
    capacityReadings(
      "a",
      "claude",
      { ...quota, windows: [...quota.windows, ...quota.windows] },
      now,
    ),
    [],
  );
});

test("Home's Max 20x quota detail produces a recognised weekly contribution without renaming the plan", () => {
  const quota = observation({ id: "claude-seven-day", window_seconds: 604_800 }, "Max 20x");
  const [reading] = capacityReadings("max-seat", "claude", quota, now);
  assert.ok(reading);
  assert.equal(reading.plan, "Max 20x");
  assert.equal(reading.full, 20);
  assert.equal(reading.remaining, 8);
  assert.equal(reading.knownWeight, true);
  assert.equal(reading.source, "plan-multiplier");
  assert.equal(reading.revision, "2026-11-09-max20x-20");
});

test("absolute weekly allowances retain their unchanged revision", () => {
  const [reading] = capacityReadings(
    "seat",
    "claude",
    observation(
      {
        id: "claude-seven-day",
        window_seconds: 604_800,
        unit: "credits",
        limit: 300,
        remaining: 200,
      },
      "Max 20x",
    ),
    now,
  );
  assert.equal(reading.source, "reported-absolute");
  assert.equal(reading.revision, "2026-10-30");
});
