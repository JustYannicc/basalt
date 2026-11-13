import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicHistoryRecord } from "../history-contract.ts";
import type { OverviewMoneyMetric } from "../overview-contract.ts";
import { recordedCost, requestEstimate, requestEstimateBasis } from "./history-request-cost.ts";

const record: PublicHistoryRecord = {
  id: "fixture-request",
  timestamp: "2026-11-12T00:00:00Z",
  person: null,
  request_id: null,
  provider: "fixture",
  model: "fixture-model",
  endpoint: null,
  api_type: "chat-completions",
  service_tier: null,
  input_tokens: "1200",
  output_tokens: "300",
  cache_read_tokens: "0",
  cache_write_tokens: "0",
  reasoning_tokens: "0",
  total_tokens: "1500",
  token_quality: "complete",
  latency_ms: "900",
  failed: false,
  status_code: 200,
  cost: "41.5",
  currency: "credits",
  cost_basis: "home-charge",
  attribution: "key-at-capture",
};

const metric = (patch: Partial<OverviewMoneyMetric> = {}): OverviewMoneyMetric => ({
  status: "available",
  amount: "0.0412",
  currency: "USD",
  pricedRequests: 1,
  excluded: { unknownKind: 0, unknownKindValue: null, unpriced: 0 },
  price: {
    source: "models.dev",
    version: "v1",
    asOf: "2026-11-10T00:00:00Z",
    basis: "live",
    refreshFailed: false,
  },
  ...patch,
});

test("the row amount is the current USD estimate, never the stored credits", () => {
  const shown = requestEstimate({ ...record, api_estimate: metric() });
  assert.equal(shown.text, "$0.04");
  assert.equal(shown.priced, true);
  assert.equal(shown.price?.basis, "live");
  assert.equal(requestEstimateBasis(shown), "Live models.dev prices, updated 10 Nov 2026.");
  assert.equal(recordedCost(record), "41.5 credits · Home charge");
});

test("a sub-cent estimate never reads as free", () => {
  const shown = requestEstimate({ ...record, api_estimate: metric({ amount: "0.0004" }) });
  assert.equal(shown.text, "<$0.01");
});

test("an older server without the estimate reads Not reported, not $0.00 or credits", () => {
  const shown = requestEstimate(record);
  assert.equal(shown.text, "Not reported");
  assert.equal(shown.priced, false);
  assert.equal(shown.price, null);
  assert.match(requestEstimateBasis(shown) ?? "", /doesn't report/);
});

test("an unavailable estimate says why and shows no amount", () => {
  const shown = requestEstimate({
    ...record,
    api_estimate: metric({ status: "unavailable", amount: null, reason: "No public rate." }),
  });
  assert.deepEqual(shown, {
    text: "Unavailable",
    priced: false,
    price: null,
    reason: "No public rate.",
  });
  assert.equal(requestEstimateBasis(shown), "No public rate.");
  const unexplained = requestEstimate({
    ...record,
    api_estimate: metric({ status: "unavailable", amount: null }),
  });
  assert.equal(unexplained.reason, "No reason was recorded.");
});

test("an available estimate without an amount is unpriced; a malformed one is unavailable", () => {
  const unpriced = requestEstimate({ ...record, api_estimate: metric({ amount: null }) });
  assert.equal(unpriced.text, "Unpriced");
  const malformed = requestEstimate({ ...record, api_estimate: metric({ amount: "1e3" }) });
  assert.equal(malformed.text, "Unavailable");
  assert.equal(malformed.priced, false);
});

test("token-count pricing and failed refreshes carry into the expanded basis", () => {
  const shown = requestEstimate({
    ...record,
    api_estimate: metric({
      price: {
        source: "models.dev",
        version: "v1",
        asOf: "2026-11-03T00:00:00Z",
        basis: "baseline",
        refreshFailed: true,
        calculation: "token-counts",
      },
    }),
  });
  assert.equal(shown.price?.calculation, "token-counts");
  assert.equal(
    requestEstimateBasis(shown),
    "Shipped baseline models.dev prices, as of 3 Nov 2026. Price refresh failed. Priced from its recorded token counts because usable API usage details were missing.",
  );
});

test("a token-bearing failure keeps its USD estimate", () => {
  const failed = { ...record, failed: true, status_code: 500, api_estimate: metric() };
  assert.equal(requestEstimate(failed).text, "$0.04");
});

test("a named failure with no recorded usage reads No usage recorded, not Unpriced", () => {
  const failed: PublicHistoryRecord = {
    ...record,
    failed: true,
    status_code: 502,
    input_tokens: "0",
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    total_tokens: "0",
    cost: null,
    currency: null,
    cost_basis: "unpriced",
    api_estimate: metric({ amount: "0" }),
  };
  const shown = requestEstimate(failed);
  assert.equal(shown.text, "No usage recorded");
  assert.equal(requestEstimateBasis(shown), null);
  assert.equal(recordedCost(failed), "Not recorded");
});

test("a successful zero-usage request keeps its own estimate", () => {
  const zero: PublicHistoryRecord = {
    ...record,
    input_tokens: "0",
    output_tokens: "0",
    total_tokens: "0",
    cost: null,
    cost_basis: "unpriced",
    api_estimate: metric({ amount: "0" }),
  };
  assert.equal(requestEstimate(zero).text, "$0.00");
});

test("retained historical API prices keep their basis and currency as stored", () => {
  assert.equal(
    recordedCost({
      ...record,
      cost: "0.00412",
      currency: "USD",
      cost_basis: "historical-api-price",
    }),
    "0.00412 USD · Historical API price",
  );
  assert.equal(
    recordedCost({ ...record, currency: null }),
    "41.5 currency not recorded · Home charge",
  );
});
