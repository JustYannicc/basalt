import assert from "node:assert/strict";
import { test } from "node:test";
import type { OverviewApiPrice } from "../../apps/pool/overview-contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

/** A long-context tier on one model, so a request's context band chooses its rate. */
const prices: readonly OverviewApiPrice[] = [
  ...summaryPrices,
  { ...summaryPrices[1]!, minInput: "200001", input: "20", output: "60", cacheRead: "4" },
];

/** Requests of every shape the summary prices, counts or redacts differently. */
async function history(f: Parameters<Parameters<typeof seriesFixture>[0]>[0]) {
  const fixture = await summaryFixture(f);
  const gateway = await digest("pool-gateway-v1");
  const imported = await digest("fixture-import");
  let id = 0;
  for (let day = 0; day < 9; day++)
    for (let hour = 0; hour < 24; hour += 5) {
      const at = (minute: number) =>
        new Date(Date.UTC(2026, 0, 1 + day, hour, minute, 7)).toISOString();
      await fixture.native(++id, at(1), { model: "fixture-model-0" });
      await fixture.native(++id, at(2), {
        model: "fixture-model-1",
        apiType: "responses",
        inputTokens: String(150_000 + day * 20_000),
        cacheReadTokens: "1000",
        cacheWriteTokens: "500",
        outputTokens: "333",
        totalTokens: String(150_333 + day * 20_000),
      });
      await fixture.native(++id, at(3), {
        account: fixture.hidden,
        apiType: "messages",
        tokenQuality: "legacy",
      });
      await fixture.native(++id, at(4), { failed: true, statusCode: hour % 2 ? 429 : 500 });
      await f.insert(
        {
          source: gateway,
          timestamp: timestamp(at(5)),
          provider: "fixture-lab",
          model: "fixture-model-0",
          failed: true,
          statusCode: 503,
          attribution: "key-at-capture",
        },
        {
          source: imported,
          attribution: "import-owner",
          account: `i:${"e".repeat(62)}`,
          timestamp: timestamp(at(6)),
          provider: "fixture-lab",
          model: "fixture-model-1",
          inputTokens: "900",
          outputTokens: "90",
          cacheReadTokens: "0",
          cacheWriteTokens: "0",
          totalTokens: "990",
          tokenQuality: "complete",
          costBasis: "historical-api-price",
          cost: "0.0123",
          currency: "USD",
        },
        { timestamp: timestamp(at(7)), provider: "fixture-lab", model: null },
      );
    }
  await fixture.cursor(id);
  await fixture.analyze();
  return fixture;
}

async function summary(db: HistoryDatabase, authority: unknown, by: "provider" | "model") {
  const to = "2026-01-09T13:37:12.000000123Z";
  return poolUsageSummary(
    db,
    { pool, from: "2026-01-02T23:00:00Z", to, by, authority },
    async () => ({ prices, issues: [] }),
    Date.parse(to),
  );
}

test("a summary read from the rollup is identical to the same summary read from raw rows", async () => {
  await seriesFixture(async (f) => {
    const fixture = await history(f);
    const raw = {
      provider: await summary(f.db, fixture.authority, "provider"),
      model: await summary(f.db, fixture.authority, "model"),
    };
    const poolId = (await digest(pool)).slice(0, 16);
    for (let day = 0; day < 10; day++)
      await f.db.query("SELECT basalt_model_usage_recompute($1,$2::timestamptz,$3::timestamptz)", [
        poolId,
        new Date(Date.UTC(2025, 11, 31 + day)).toISOString(),
        new Date(Date.UTC(2025, 11, 32 + day)).toISOString(),
      ]);
    await f.db.query("INSERT INTO basalt_model_usage_ready (pool,through) VALUES ($1,$2)", [
      poolId,
      "2026-01-10T00:00:00Z",
    ]);
    const statements: string[] = [];
    const counted: HistoryDatabase = {
      query: (text, values) => {
        statements.push(text);
        return f.db.query(text, values);
      },
    };
    const rolled = {
      provider: await summary(counted, fixture.authority, "provider"),
      model: await summary(counted, fixture.authority, "model"),
    };
    assert.ok(
      statements.some((text) => text.includes("basalt_model_usage_hourly")),
      "the second read uses the rollup",
    );
    // Only the reads' own transaction times may differ; every usage figure must not.
    const data = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value, (key, field) =>
          key === "capturedAt" || key === "asOf" ? "read time" : field,
        ),
      );
    assert.deepEqual(data(rolled.provider), data(raw.provider));
    assert.deepEqual(data(rolled.model), data(raw.model));
    assert.ok(raw.provider.daily.length > 0 && raw.model.models?.status === "available");
  });
});
