import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsageImport } from "../../src/pool/model-history/import.ts";
const source = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const owner = { pool: "fixture-pool", person: "fixture-person" };
const event = {
  event_hash: "a".repeat(64),
  timestamp: "2026-05-05T11:32:18.619000001Z",
  failed: false,
  provider: "fixture-provider",
  model: "fixture-model",
  endpoint: "/v1/responses",
  input_tokens: "100",
  output_tokens: "10",
  total_tokens: "110",
  status_code: 200,
  account_ref: "private-account-reference",
  client_key_ref: "private-key-reference",
  raw_json: "private-payload",
  ip: "private-ip",
  amount: "999",
  currency: "USD",
};
const parse = (rows: unknown[], extra = {}) =>
  parseUsageImport(
    {
      source,
      format: "cpamp-v1-jsonl",
      data: rows.map((row) => JSON.stringify(row)).join("\n"),
      ...extra,
    },
    owner,
  );
test("Manager Plus retains source identity and nanoseconds without payloads or invented billing", async () => {
  const first = await parse([event]),
    row = first.records[0]!;
  assert.equal(row.timestamp, event.timestamp);
  assert.equal(row.inputTokens, "100");
  assert.equal(row.cacheWriteTokens, null);
  assert.equal(row.tokenQuality, "legacy");
  assert.equal(row.cost, null);
  assert.equal(row.costBasis, "unpriced");
  assert.equal(row.attribution, "import-owner");
  assert.doesNotMatch(JSON.stringify(first), /private-/);
  assert.equal((await parse([{ ...event, id: 123 }])).records[0]!.id, row.id);
  assert.notEqual(
    (await parse([event], { source: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" })).records[0]!.id,
    row.id,
  );
  assert.notEqual((await parse([{ ...event, event_hash: "b".repeat(64) }])).records[0]!.id, row.id);
});
test("Manager Plus failures and zero-token events survive without inventing unknowns", async () => {
  const parsed = await parse([
    {
      ...event,
      failed: true,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      status_code: null,
    },
  ]);
  assert.equal(parsed.records[0]!.failed, true);
  assert.equal(parsed.records[0]!.totalTokens, "0");
  assert.equal(parsed.records[0]!.statusCode, null);
  for (const change of [
    { event_hash: null },
    { event_hash: "raw-secret" },
    { failed: null },
    { status_code: 600 },
    { input_tokens: -1 },
    { timestamp: "invalid" },
  ])
    await assert.rejects(parse([{ ...event, ...change }]));
  await assert.rejects(parse([event], { source: "home-local-v1" }));
});
test("Manager Plus pagination keeps stable identities across bounded pages", async () => {
  const rows = Array.from({ length: 201 }, (_, i) => ({
    ...event,
    event_hash: i.toString(16).padStart(64, "0"),
  }));
  const first = await parse(rows),
    last = await parse(rows, { offset: 200 });
  assert.equal(first.records.length, 200);
  assert.equal(first.next, 200);
  assert.equal(last.records.length, 1);
  assert.equal(last.next, null);
  assert.equal((await parse([rows[200]])).records[0]!.id, last.records[0]!.id);
});
