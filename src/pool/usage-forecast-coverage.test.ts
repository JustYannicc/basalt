import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apiEquivalentUnavailable,
  outsideSeries,
  type PoolUsageSeriesResult,
  type SeriesBucket,
} from "../../apps/pool/usage-series-contract.ts";
import { seriesUsageForecasts } from "./model-history/usage-forecasts.ts";
import { addUsageDays, usageDayStart } from "./usage-calendar.ts";

const now = "2026-11-09T11:00:00Z";
const capture = (...hours: string[]) => ({ capturedAt: now, incompleteHours: new Set(hours) });
function fixture(): PoolUsageSeriesResult {
  const buckets: SeriesBucket[] = Array.from({ length: 84 }, (_, day) => {
    const token = { sum: "1000", known: 100, missing: 0 };
    const cost = { amount: null, currency: null, priced: 0, unpriced: 100 };
    return {
      at: new Date(usageDayStart(addUsageDays("2026-08-17", day))).toISOString(),
      partial: false,
      requests: 100,
      failed: 0,
      unassignedFailures: 0,
      successRate: 1,
      lastSuccessAtInRange: null,
      tokens: {
        input: token,
        output: token,
        cacheRead: token,
        cacheWrite: token,
        reasoning: token,
        total: token,
      },
      tokenQuality: { complete: 100, legacy: 0, unclassified: 0, inconsistent: 0 },
      cost: {
        homeCharge: cost,
        importedApiPrice: cost,
        apiEquivalent: apiEquivalentUnavailable,
        unpricedRequests: 100,
        apiEstimate: {
          status: "available",
          amount: "1.000000000000",
          currency: "USD",
          pricedRequests: 100,
          excluded: { unknownKind: 0, unknownKindValue: null, unpriced: 0 },
          price: null,
        },
      },
      attribution: { chargeSnapshot: 0, keyAtCapture: 100, importOwner: 0, unknown: 0 },
    };
  });
  return {
    from: "2026-08-16T22:00:00Z",
    to: now,
    bucket: "day",
    timezone: "Europe/Zurich",
    asOf: now,
    next: null,
    coverage: {
      sources: [
        {
          source: "home",
          kind: "home",
          firstAt: buckets[0]!.at,
          lastAt: buckets.at(-1)!.at,
          backfillComplete: true,
          sweep: { id: "0", upper: "0" },
        },
      ],
      firstAt: buckets[0]!.at,
      lastAt: buckets.at(-1)!.at,
      capturedThrough: buckets.at(-1)!.at,
      mapping: {
        current: true,
        historicalGenerations: "unknown",
        proof: "proven",
        mapped: 8400,
        unmapped: 0,
        otherAccounts: 0,
      },
      pricing: {
        homeCharge: 0,
        importedApiPrice: 0,
        unpriced: 0,
        missing: 0,
        missingSnapshot: 0,
        missingVersion: 0,
        apiEquivalent: apiEquivalentUnavailable,
      },
      priceProjection: outsideSeries,
      percentiles: outsideSeries,
      seasonalTrainingRange: outsideSeries,
    },
    groups: [{ key: { currency: null, provider: "codex" }, buckets }],
  };
}

test("native backfill gaps cannot become zero-valued complete training weeks", () => {
  const result = fixture();
  result.coverage.sources[0]!.backfillComplete = false;
  const old = result.groups[0]!.buckets[0]!;
  result.groups[0]!.buckets = [old, { ...old, at: "2026-11-09T00:00:00Z", requests: 1000 }];
  const forecast = seriesUsageForecasts(result, capture());
  assert.equal(forecast.series[0]!.requests.status, "unavailable");
  assert.match(forecast.warnings.join(" "), /capture is incomplete/);
});

test("stalled native forward capture leaves later elapsed days unknown", () => {
  const result = fixture();
  const forecast = seriesUsageForecasts(result, capture("2026-11-08T08:00:00Z"));
  assert.equal(forecast.series[0]!.requests.status, "unavailable");
  assert.match(forecast.warnings.join(" "), /uncaptured requests/);
});

test("same-day native capture lag keeps current-period actuals and projections unknown", () => {
  const result = fixture();
  const forecast = seriesUsageForecasts(result, capture("2026-11-09T08:00:00Z"));
  const requests = forecast.series[0]!.requests;
  assert.equal(requests.status, "available");
  if (requests.status !== "available") return;
  assert.equal(requests.thisWeek.actual, null);
  assert.equal(requests.thisWeek.median, null);
  assert.equal(requests.month.median, null);
  assert.equal(requests.confidence, "Low");
  assert.ok(forecast.warnings.length > 0);
});

test("fresh native capture can establish idle days despite an older last request timestamp", () => {
  const result = fixture();
  const forecast = seriesUsageForecasts(result, capture());
  assert.equal(forecast.series[0]!.requests.status, "available");
  const requests = forecast.series[0]!.requests;
  if (requests.status !== "available") return;
  assert.equal(requests.confidence, "High");
  assert.equal(requests.coverage.basis, "recorded-total");
  assert.ok(requests.thisWeek.median !== null);
});

test("mixed known and missing metrics forecast an explicitly labelled Low-confidence subset", () => {
  const result = fixture();
  for (const value of result.groups[0]!.buckets) {
    assert.ok("tokens" in value);
    value.tokens.total = { sum: "990", known: 99, missing: 1 };
    value.cost.apiEstimate = {
      ...value.cost.apiEstimate!,
      pricedRequests: 99,
      excluded: { ...value.cost.apiEstimate!.excluded, unpriced: 1 },
    };
  }
  const forecast = seriesUsageForecasts(result, capture()).series[0]!;
  for (const metric of [forecast.tokens, forecast.apiEstimate]) {
    assert.equal(metric.status, "available");
    if (metric.status !== "available") continue;
    assert.equal(metric.confidence, "Low");
    assert.deepEqual(metric.coverage, { basis: "known-subset", excludedRequests: 84 });
  }
  assert.equal(forecast.requests.status, "available");
  if (forecast.requests.status === "available") assert.equal(forecast.requests.confidence, "High");
});
