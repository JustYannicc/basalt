import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicHistoryRecord } from "../history-contract.ts";
import { failedRecordWithoutUsage } from "./usage-outcome.ts";

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

test("only protection failures with no model, counters or cost get the no-usage label", () => {
  assert.equal(failedRecordWithoutUsage(failure), true);
  for (const changed of [
    { failed: false },
    { api_type: null },
    { model: "fixture-model" },
    { input_tokens: "0" },
    { output_tokens: "1" },
    { cache_read_tokens: "1" },
    { cache_write_tokens: "1" },
    { reasoning_tokens: "1" },
    { total_tokens: "0" },
    { cost: "0" },
  ])
    assert.equal(failedRecordWithoutUsage({ ...failure, ...changed }), false);
});
