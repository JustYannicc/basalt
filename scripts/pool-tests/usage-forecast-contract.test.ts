import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { PoolUsageForecasts } from "../../.upstream/apps/hosted/server/src/contracts/pool-usage-forecast.ts";
import type { UsageForecasts } from "../../apps/pool/usage-forecast-contract.ts";
import { usageForecast } from "../../src/pool/usage-forecast.ts";

const calculatedAt = "2026-11-09T11:00:00Z";
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(PoolUsageForecasts));

function response(forecast: ReturnType<typeof usageForecast>) {
  return {
    calculatedAt,
    timezone: "Europe/Zurich",
    basis: "recorded-usage",
    warnings: [],
    series: [
      {
        provider: null,
        requests: forecast,
        tokens: forecast,
        apiEstimate: forecast,
        excluded: { tokens: 0, apiEstimate: 0 },
      },
    ],
  } satisfies UsageForecasts;
}

test("the forecast wire contract preserves producer missing days and unknown values", () => {
  const forecast = usageForecast({
    calculatedAt,
    days: [{ day: "2026-11-02", value: null, requests: 1 }],
  });
  assert.equal(forecast.status, "unavailable");
  assert.ok("historyGaps" in forecast && forecast.historyGaps?.length === 4);
  assert.deepEqual(forecast.historyGaps.at(-1)?.unknownDays, ["2026-11-02"]);
  assert.equal(forecast.historyGaps.at(-1)?.missingDays.length, 6);
  const input = response(forecast);
  assert.deepEqual(decode(JSON.stringify(input)), input);
});

test("forecasts without gap details remain compatible", () => {
  const input = response(usageForecast({ calculatedAt: "invalid", days: [] }));
  assert.equal("historyGaps" in input.series[0].requests, false);
  assert.deepEqual(decode(JSON.stringify(input)), input);
});

test("the forecast wire contract rejects malformed gap details", () => {
  const input = response(usageForecast({ calculatedAt, days: [] }));
  for (const gap of [
    { week: 42, missingDays: [], unknownDays: [] },
    { week: "2026-11-02", missingDays: [42], unknownDays: [] },
    { week: "2026-11-02", missingDays: [], unknownDays: [42] },
  ]) {
    const series = input.series.map((entry) => ({
      ...entry,
      requests: { ...entry.requests, historyGaps: [gap] },
    }));
    assert.throws(() => decode(JSON.stringify({ ...input, series })));
  }
});
