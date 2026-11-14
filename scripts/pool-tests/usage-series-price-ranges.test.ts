import assert from "node:assert/strict";
import { test } from "node:test";
import { pricedRowsSql } from "../../src/pool/model-history/overview-sql.ts";
import { seriesFixture } from "./series-fixture.ts";

const rates = [
  { model: "both", tier: "*", min_input: "0", version: "default" },
  { model: "both", tier: "*", min_input: "1000", version: "default-long" },
  { model: "both", tier: "priority", min_input: "0", version: "priority" },
  { model: "both", tier: "priority", min_input: "1200", version: "priority-long" },
  { model: "both", tier: "flex", min_input: "1000", version: "flex" },
  { model: "specific-only", tier: "priority", min_input: "1000", version: "specific" },
  { model: "nullable", tier: "*", min_input: "0", version: "fallback" },
  { model: "nullable", tier: "priority", min_input: "0", version: null },
  { model: "both", tier: null, min_input: "0", version: "ignored-null-tier" },
  { model: "both", tier: "*", min_input: null, version: "ignored-null-threshold" },
].map((rate, index) => ({
  ...rate,
  provider: "synthetic-provider",
  currency: "USD",
  input: index % 2 ? "0.123456789012" : "0.246913578024",
  output: "1.000000000001",
  cache_read: "0.01",
  cache_write: index % 2 ? "0" : "0.5",
  request: "0.000000000001",
  as_of: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
  source: "models.dev",
  basis: index % 2 ? "baseline" : "live",
  refresh_failed: index % 2 === 1,
}));

const requestColumns = `id text,provider text,model text,service_tier text,
  input_tokens bigint,output_tokens bigint,cache_read_tokens bigint,cache_write_tokens bigint,
  reasoning_tokens bigint,total_tokens bigint,token_quality text,api_type text,eligible boolean,counts_only boolean`;

interface PriceRequest {
  id: string;
  provider: string | null;
  model: string | null;
  service_tier: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  reasoning_tokens: string | null;
  total_tokens: string | null;
  token_quality: string;
  api_type: string | null;
  eligible: boolean | null;
  counts_only: boolean | null;
}

test("range price joins equal per-request lookup across tiers, thresholds, token formats, guards and missing rates", async () => {
  await seriesFixture(async ({ db }) => {
    const requests: PriceRequest[] = [];
    for (const token_quality of ["complete", "legacy", "inconsistent", "unclassified"])
      for (const api_type of ["responses", "responses-compact", "messages", "unknown", null])
        for (const input_tokens of [null, "0", "20", "999", "1000", "1199", "1200", "1201"])
          for (const service_tier of [null, "*", "priority", "flex", "unknown"])
            for (const model of ["both", "specific-only", "nullable", "missing", null])
              requests.push({
                id: String(requests.length),
                provider: "synthetic-provider",
                model,
                service_tier,
                input_tokens,
                output_tokens: "17",
                cache_read_tokens: "20",
                cache_write_tokens: "10",
                reasoning_tokens: "3",
                total_tokens: input_tokens === null ? null : String(BigInt(input_tokens) + 50n),
                token_quality,
                api_type,
                eligible: true,
                counts_only: false,
              });
    const base = requests.find(
      (request) =>
        request.model === "both" &&
        request.service_tier === "priority" &&
        request.token_quality === "complete" &&
        request.input_tokens === "1000",
    )!;
    for (const overrides of [
      { eligible: false },
      { eligible: null },
      { counts_only: true },
      { counts_only: null },
      { provider: null },
      { output_tokens: null },
      { cache_read_tokens: null },
      { cache_write_tokens: null },
      { reasoning_tokens: null },
      { total_tokens: null },
      { input_tokens: "9007199254740993", total_tokens: "9007199254741043" },
    ])
      requests.push({ ...base, ...overrides, id: String(requests.length) });

    const read = async (optimized: boolean, prices: unknown[]) => {
      const result = await db.query(
        `WITH selected AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(${requestColumns})
      ), ${pricedRowsSql("selected", "$2", "s.eligible AND NOT s.counts_only", "public_", optimized)}
      SELECT id,context_input::text,public_price_version,public_price_as_of,public_price_basis,
        public_price_refresh_failed,token_count_estimate,api_cost::text FROM priced ORDER BY id`,
        [JSON.stringify(requests), JSON.stringify(prices)],
      );
      assert.equal(result.rows.length, requests.length, "one priced result per request");
      return result.rows;
    };
    for (const prices of [
      rates,
      [],
      [...rates, rates[0]!],
      rates.filter((rate) => rate.tier !== "*"),
    ]) {
      const expected = await read(false, prices);
      const actual = await read(true, prices);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    }
  });
});
