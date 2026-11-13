import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicHistoryRecord } from "../history-contract.ts";
import { failedRecordWithoutUsage, requestTitle } from "./usage-outcome.ts";

const failure: PublicHistoryRecord = {
  id: "fixture-failure",
  timestamp: "2026-11-12T00:00:00Z",
  person: null,
  request_id: null,
  provider: null,
  model: null,
  endpoint: null,
  api_type: "pool-protection-unavailable",
  service_tier: null,
  input_tokens: null,
  output_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  reasoning_tokens: null,
  total_tokens: null,
  token_quality: "unclassified",
  latency_ms: null,
  failed: true,
  status_code: 503,
  cost: null,
  currency: null,
  cost_basis: "unpriced",
  attribution: "unknown",
};

const estimate = (amount: string | null) => ({
  status: "available" as const,
  amount,
  currency: "USD" as const,
  pricedRequests: amount === null ? 0 : 1,
  excluded: { unknownKind: 0, unknownKindValue: null, unpriced: amount === null ? 1 : 0 },
  price: null,
});

test("a failure with no counters and no positive cost has no usage, whatever its model", () => {
  for (const named of [
    failure,
    { ...failure, model: "fixture-model", provider: "fixture", api_type: "chat-completions" },
    { ...failure, model: "fixture-model", input_tokens: "0", total_tokens: "0" },
    { ...failure, model: "fixture-model", cost: "0", cost_basis: "home-charge" as const },
    { ...failure, model: "fixture-model", cost: "0.000", api_estimate: estimate("0") },
    { ...failure, model: "fixture-model", api_estimate: estimate(null) },
  ])
    assert.equal(failedRecordWithoutUsage(named), true);
});

test("tokens, a positive cost or a positive estimate mean the failure did record usage", () => {
  for (const changed of [
    { failed: false },
    { input_tokens: "1" },
    { output_tokens: "1" },
    { cache_read_tokens: "1" },
    { cache_write_tokens: "1" },
    { reasoning_tokens: "1" },
    { total_tokens: "12" },
    { total_tokens: "unexpected" },
    { cost: "0.4", cost_basis: "home-charge" as const },
    { api_estimate: estimate("0.0001") },
  ])
    assert.equal(failedRecordWithoutUsage({ ...failure, ...changed }), false);
});

test("a successful request with zero counters is not a no-usage failure", () => {
  const zero = { ...failure, failed: false, status_code: 200, total_tokens: "0" };
  assert.equal(failedRecordWithoutUsage(zero), false);
  assert.equal(requestTitle(zero), "Model not recorded");
});

test("the recorded model names the row; only unnamed no-usage failures read Failed request", () => {
  assert.equal(requestTitle(failure), "Failed request");
  assert.equal(requestTitle({ ...failure, model: "fixture-model" }), "fixture-model");
  assert.equal(
    requestTitle({ ...failure, model: "fixture-model", total_tokens: "40" }),
    "fixture-model",
  );
  assert.equal(requestTitle({ ...failure, total_tokens: "40" }), "Model not recorded");
});
