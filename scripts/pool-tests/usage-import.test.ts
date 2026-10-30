import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseUsageImport } from "../../src/pool/model-history/import.ts";

const owner = { pool: "fixture-pool", person: "fixture-person" };
const source = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const home = (index: number) => ({
  usage_id: index + 1, request_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  timestamp: "2020-01-01T12:00:00.123456Z", provider: "fixture-provider", model: "fixture-model",
  endpoint: "/v1/responses", failed: false, status_code: 200, api_key_id: 1, credential_id: "fixture-account",
  token_breakdown_schema_version: 2, token_breakdown_quality: "complete",
  token_breakdown_input_total_tokens: 100, token_breakdown_input_cache_read_tokens: 20,
  token_breakdown_input_cache_write_tokens: 5, token_breakdown_output_total_tokens: 10,
  token_breakdown_output_reasoning_tokens: 3, token_breakdown_total_tokens: 110,
  latency_ms: 250, amount: null,
  error_body_preview: "fixture-response-sentinel", api_key_label: "fixture-key-label", prompt: "fixture-prompt-sentinel",
});

test("Home export batches beyond 10k retain stable request identities and exclude content", async () => {
  const identities = new Set<string>();
  for (let start = 0; start < 10_005; start += 200) {
    const data = Array.from({ length: Math.min(200, 10_005 - start) }, (_, offset) => JSON.stringify(home(start + offset))).join("\n");
    const input = { source, format: "home-v8-jsonl", data };
    const result = await parseUsageImport(input, owner);
    for (const record of result.records) identities.add(record.id);
    const retained = JSON.stringify(result);
    assert.doesNotMatch(retained, /fixture-response-sentinel|fixture-key-label|fixture-prompt-sentinel/);
    assert.deepEqual((await parseUsageImport(input, owner)).records.map((row) => row.id), result.records.map((row) => row.id));
    assert.equal(result.next, null);
  }
  assert.equal(identities.size, 10_005);
});

test("legacy snapshots preserve detail multiplicity, nanoseconds and aggregate-only gaps", async () => {
  const detail = { timestamp: "2020-01-01T12:00:00.123456789+02:00", auth_index: "fixture-auth", source: "fixture-secret-bearing-source",
    failed: false, tokens: { input_tokens: 100, output_tokens: 10, cached_tokens: 20, reasoning_tokens: 3, total_tokens: 110 } };
  const data = JSON.stringify({ version: 1, usage: { total_requests: 5, apis: {
    "fixture-raw-api-key": { models: { "fixture-model": { total_requests: 5, details: [detail, detail,
      { ...detail, timestamp: "2020-01-01T12:00:00.123456788+02:00" }] } } },
  } } });
  const result = await parseUsageImport({ source, format: "cpa-v6", data }, owner);
  assert.equal(result.records.length, 3);
  assert.equal(new Set(result.records.map((row) => row.id)).size, 3);
  assert.equal(result.records[0]!.timestamp, "2020-01-01T10:00:00.123456789Z");
  assert.equal(result.report.aggregateOnlyNotImportable, "2");
  assert.equal(result.report.indistinguishableDetails, 1);
  assert.equal(result.records[0]!.provider, null);
  assert.equal(result.records[0]!.cacheWriteTokens, null);
  assert.equal(result.records[0]!.cost, null);
  assert.doesNotMatch(JSON.stringify(result), /fixture-raw-api-key|fixture-secret-bearing-source/);
  const empty = await parseUsageImport({ source, format: "cpa-v6", data: JSON.stringify({ version: 1, usage: { total_requests: 8, apis: {} } }) }, owner);
  assert.equal(empty.records.length, 0);
  assert.equal(empty.report.aggregateOnlyNotImportable, "8");
});

test("dated API prices use the request date and preserve the selected immutable rates", async () => {
  const raw = home(0);
  const price = { provider: raw.provider, model: raw.model, currency: "USD", tier: "*",
    input: "2", output: "8", cacheRead: "0.5", cacheWrite: "2.5", request: "0",
    validFrom: "2019-01-01T00:00:00Z", validTo: "2021-01-01T00:00:00Z" };
  const input = { source, format: "home-v8-jsonl", data: JSON.stringify(raw), prices: [price] };
  const parsed = await parseUsageImport(input, owner), row = parsed.records[0]!;
  assert.equal(row.cost, "0.000252500000");
  assert.equal(row.currency, "USD");
  assert.equal(row.price!.input, "2");
  assert.equal(row.costBasis, "historical-api-price");
  const currentOnly = await parseUsageImport({ ...input, prices: [{ ...price, validFrom: "2025-01-01T00:00:00Z", validTo: "2027-01-01T00:00:00Z" }] }, owner);
  assert.equal(currentOnly.records[0]!.cost, null);
  assert.notEqual((await parseUsageImport({ ...input, source: randomUUID() }, owner)).records[0]!.id, row.id);
  await assert.rejects(parseUsageImport({ ...input, prices: [price, price] }, owner));
});
