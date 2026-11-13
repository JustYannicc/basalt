import assert from "node:assert/strict";
import { test } from "node:test";
import type { OverviewApiPrice } from "../../apps/pool/overview-contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { importedManagerRequest } from "../../src/pool/model-history/import-cpamp.ts";
import {
  officialCosts,
  officialCostMetric,
  officialCostTargets,
  officialCostSlices,
} from "../../src/pool/model-history/official-cost.ts";
import { readPricedRequests } from "../../src/pool/model-history/priced-history.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { full, pool, seriesFixture } from "./series-fixture.ts";

const from = "2026-01-01T00:00:00Z",
  to = "2026-01-02T00:00:00Z";
const cases = [
  {
    provider: "codex",
    model: "gpt-6.1-sol",
    input_tokens: "15000",
    output_tokens: "30",
    cache_read_tokens: "2800",
    cache_write_tokens: "0",
    reasoning_tokens: "0",
    total_tokens: "15030",
    expected: "0.024980000000",
    rates: ["2", "10", "0.1", "2.5"],
  },
  {
    provider: "xai",
    model: "grok-4.6",
    input_tokens: "220",
    output_tokens: "120",
    cache_read_tokens: "130",
    cache_write_tokens: "0",
    reasoning_tokens: "110",
    total_tokens: "340",
    expected: "0.000965000000",
    rates: ["2", "6", "0.5", "2.5"],
  },
  {
    provider: "claude",
    model: "claude-opus-5-5",
    input_tokens: "2",
    output_tokens: "4",
    cache_read_tokens: "0",
    cache_write_tokens: "54000",
    reasoning_tokens: "0",
    total_tokens: "54006",
    expected: "0.270088000000",
    rates: ["4", "20", "0.2", "5"],
  },
  {
    provider: "claude",
    model: "claude-opus-5-5",
    input_tokens: "2",
    output_tokens: "3",
    cache_read_tokens: "5000",
    cache_write_tokens: "2800",
    reasoning_tokens: "0",
    total_tokens: "7805",
    expected: "0.015068000000",
    rates: ["4", "20", "0.2", "5"],
  },
];
const prices: OverviewApiPrice[] = cases.slice(0, 3).map((c) => ({
  provider: c.provider,
  model: c.model,
  currency: "USD",
  input: c.rates[0]!,
  output: c.rates[1]!,
  cacheRead: c.rates[2]!,
  cacheWrite: c.rates[3]!,
  request: "0",
  tier: "*",
  minInput: "0",
  source: "models.dev",
  version: "fixture-rates",
  asOf: from,
}));

test("imported provider counters share current USD estimates across requests, History and lab costs without rewriting retained rows", async () => {
  await seriesFixture(async (f) => {
    const source = await digest("frozen-import"),
      person = await digest("fixture-import-owner"),
      poolId = (await digest(pool)).slice(0, 16);
    const records = await Promise.all(
      cases.map((c, i) =>
        importedManagerRequest(
          {
            ...c,
            event_hash: String(i + 1).repeat(64),
            timestamp: from,
            failed: false,
            endpoint: null,
            account_ref: i === 1 ? null : "synthetic-foreign-account",
          },
          { source, pool: poolId, person },
        ),
      ),
    );
    await f.insert(...records);
    const unknown = await importedManagerRequest(
      {
        ...cases[0],
        model: null,
        event_hash: "a".repeat(64),
        timestamp: from,
        failed: false,
      },
      { source, pool: poolId, person },
    );
    await f.insert(
      unknown,
      {
        ...unknown,
        id: "b".repeat(64),
        sourceRecord: "b".repeat(64),
        model: cases[0]!.model,
        cacheWriteTokens: null,
      },
      {
        ...unknown,
        id: "c".repeat(64),
        sourceRecord: "c".repeat(64),
        model: "unpublished-model",
      },
    );
    const fingerprint = async () =>
      (
        await f.db.query(
          "SELECT md5(string_agg(row_to_json(r)::text,',' ORDER BY id)) AS hash FROM basalt_model_requests r",
        )
      ).rows[0]!.hash;
    const before = await fingerprint();
    const wanted: unknown[] = [];
    const currentPrices = async (targets: readonly { provider: string; model: string }[]) => {
      wanted.push(targets);
      return { prices, issues: [] };
    };
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.set("options", `-c search_path=${f.schema}`);
    const page = await readPricedRequests(
      url.toString(),
      { pool: (await digest(pool)).slice(0, 16), from, to },
      currentPrices,
    );
    for (const [i, c] of cases.entries()) {
      const row = page.records.find((r) => r.id === records[i]!.id)!;
      assert.equal(row.api_estimate.amount, c.expected, c.provider);
      assert.equal(row.api_estimate.price?.calculation, "token-counts");
      assert.equal(row.cost, null);
      assert.equal(
        row.cost_basis,
        "unpriced",
        "current prices never replace the historical billing basis",
      );
    }
    assert.equal(page.records.find((r) => r.id === unknown.id)!.api_estimate.amount, null);
    assert.match(
      page.records.find((r) => r.id === unknown.id)!.api_estimate.reason ?? "",
      /Model not recorded/,
    );
    const missingCounters = page.records.find((r) => r.id === "b".repeat(64))!.api_estimate;
    assert.equal(missingCounters.amount, null);
    assert.match(missingCounters.reason ?? "", /cache_write_tokens/);
    const missingPrice = page.records.find((r) => r.id === "c".repeat(64))!.api_estimate;
    assert.equal(missingPrice.amount, null);
    assert.match(missingPrice.reason ?? "", /No public price for unpublished-model/);
    assert.ok(JSON.stringify(wanted).includes("grok-4.6"));
    const targets = await officialCostTargets(f.db, { pool, from, to });
    assert.ok(targets.targets.some((t) => t.provider === "xai"));
    const costs = await officialCosts(f.db, { pool, from, to }, prices);
    const metric = officialCostMetric(costs, prices);
    assert.equal(metric.amount, "0.311101000000");
    assert.equal(metric.pricedRequests, 4);
    assert.equal(metric.excluded.unpriced, 3);
    assert.ok(
      officialCostSlices(costs, prices, [person]).every((slice) => slice.person === null),
      "import owner is not the historical user",
    );
    const history = await poolUsageSeries(
      f.db,
      { pool, from, to, bucket: "day", by: ["provider", "model"] },
      { canManage: true, mappingProven: true, accounts: [] },
      "owned",
      currentPrices,
    );
    const buckets = history.groups.flatMap((g) => g.buckets.map(full));
    assert.equal(
      buckets.reduce(
        (sum, b) => sum + BigInt((b.cost.apiEstimate?.amount ?? "0").replace(".", "")),
        0n,
      ),
      311101000000n,
    );
    assert.equal(
      buckets.reduce((sum, b) => sum + (b.cost.apiEstimate?.pricedRequests ?? 0), 0),
      4,
    );
    assert.equal(
      buckets.reduce((sum, b) => sum + (b.cost.apiEstimate?.excluded.unpriced ?? 0), 0),
      3,
    );
    const personal = await officialCosts(f.db, { pool, from, to, person }, prices);
    assert.deepEqual(personal, [], "import-owner attribution never makes a personal charge");
    assert.equal(await fingerprint(), before);
  });
});
