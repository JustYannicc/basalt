import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareSelfImport, validateSelfImportPage } from "./model-history/self-import.ts";

const owner = { pool: "fixture-pool", caller: "fixture-manager" };
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
  amount: "999",
  currency: "USD",
  private_payload: "private-payload-sentinel",
};

test("self imports derive stable pool-scoped identity and erase owner and price attribution", async () => {
  const input = {
    format: "cpamp-v1-jsonl" as const,
    source: "fixture-database",
    data: JSON.stringify(event),
    mode: "dry-run" as const,
  };
  const first = await prepareSelfImport(input, owner);
  const repeat = await prepareSelfImport(input, { ...owner, caller: "second-manager" });
  const otherPool = await prepareSelfImport(input, { ...owner, pool: "another-pool" });
  const row = first.records[0]!;
  assert.equal(row.id, repeat.records[0]!.id);
  assert.notEqual(row.id, otherPool.records[0]!.id);
  const otherDatabase = await prepareSelfImport({ ...input, source: "another-database" }, owner);
  assert.notEqual(row.id, otherDatabase.records[0]!.id);
  assert.notEqual(row.source, otherDatabase.records[0]!.source);
  assert.equal(row.person, null);
  assert.equal(row.cost, null);
  assert.equal(row.currency, null);
  assert.equal(row.costBasis, "unpriced");
  assert.equal(row.price, null);
  assert.equal(row.priceVersion, null);
  assert.equal(row.originalPriceRule, null);
  assert.equal(row.attribution, "import-owner");
  assert.doesNotMatch(JSON.stringify(first), /private-payload-sentinel/);
});

test("Home billing metadata is discarded before parsing and every accepted row stays unpriced", async () => {
  const prepared = await prepareSelfImport(
    {
      format: "home-v8-jsonl",
      source: "fixture-database",
      data: JSON.stringify({
        usage_id: 73,
        timestamp: "2020-01-01T00:00:00Z",
        failed: false,
        provider: "fixture-provider",
        model: "fixture-model",
        amount: { secret: "not-a-decimal" },
        currency: { secret: "not-a-currency" },
        matched_price_rule: { secret: "not-a-rule" },
      }),
      mode: "dry-run",
    },
    owner,
  );
  assert.equal(prepared.records.length, 1);
  assert.equal(prepared.records[0]!.cost, null);
  assert.equal(prepared.records[0]!.currency, null);
  assert.equal(prepared.records[0]!.originalPriceRule, null);
});

test("legacy CPA offset retains a bounded page and the full aggregate-only count", async () => {
  const details = Array.from({ length: 201 }, (_, index) => ({
    timestamp: `2020-01-${String(Math.floor(index / 24) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00Z`,
    auth_index: "fixture-account",
    failed: false,
    tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }));
  const data = JSON.stringify({
    version: 1,
    usage: {
      total_requests: 250,
      apis: {
        "fixture-private-key": { models: { "fixture-model": { total_requests: 250, details } } },
      },
    },
  });
  const page = (offset: number) =>
    prepareSelfImport(
      {
        format: "cpa-v6",
        source: "fixture-database",
        data,
        offset,
        mode: "dry-run",
      },
      owner,
    );
  const first = await page(0);
  const second = await page(200);
  assert.equal(first.records.length, 200);
  assert.equal(first.totalDetails, 201);
  assert.equal(first.next, 200);
  assert.equal(first.aggregateOnlyNotImportable, "49");
  assert.equal(second.records.length, 1);
  assert.equal(second.next, null);
  assert.equal(second.records[0]!.cost, null);
  assert.equal(second.records[0]!.person, null);
  assert.doesNotMatch(JSON.stringify(first), /fixture-private-key/);
});

test("self import body rejects caller identity and pricing overrides", () => {
  const valid = {
    format: "cpamp-v1-jsonl",
    source: "fixture-database",
    data: JSON.stringify(event),
    mode: "dry-run",
  };
  assert.equal(validateSelfImportPage(valid).format, "cpamp-v1-jsonl");
  for (const override of ["pool", "person", "prices", "models"])
    assert.throws(() => validateSelfImportPage({ ...valid, [override]: "caller-value" }));
});

test("JSONL offsets are absolute progress and never discard part of the supplied page", async () => {
  const rows = Array.from({ length: 200 }, (_, index) =>
    JSON.stringify({
      ...event,
      event_hash: index.toString(16).padStart(64, "0"),
    }),
  );
  const input = {
    format: "cpamp-v1-jsonl" as const,
    source: "fixture-database",
    mode: "dry-run" as const,
    offset: 400,
    data: rows.join("\n"),
  };
  const page = await prepareSelfImport(input, owner);
  assert.equal(page.records.length, 200);
  assert.equal(page.totalDetails, 600);
  assert.equal(page.next, 600);
  const final = await prepareSelfImport({ ...input, offset: 600, data: rows[0]! }, owner);
  assert.equal(final.records.length, 1);
  assert.equal(final.totalDetails, 601);
  assert.equal(final.next, null);
  await assert.rejects(prepareSelfImport({ ...input, data: [...rows, rows[0]].join("\n") }, owner));
  for (const offset of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER])
    await assert.rejects(prepareSelfImport({ ...input, offset }, owner));
});

test("source database names must be explicit, bounded and canonical", () => {
  for (const source of [undefined, "", " ", " name", "name ", "x".repeat(121)])
    assert.throws(() =>
      validateSelfImportPage({ format: "cpamp-v1-jsonl", data: "", mode: "dry-run", source }),
    );
});
