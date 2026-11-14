import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../../src/pool/backend-users.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { historyBatchSize } from "../../src/pool/model-history/store.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryCounters, summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

const from = "2026-01-01T00:00:00Z",
  to = "2026-01-02T00:00:00Z";
const prices = async () => ({ prices: summaryPrices, issues: [] });

test("model and cost-breakdown overflow stays explicit without paging or dropping usage totals", async () => {
  for (const [models, days, modelOverflow, costOverflow] of [
    [101, 50, true, false],
    [501, 1, false, true],
  ] as const) {
    await seriesFixture(async (f) => {
      const fixture = await summaryFixture(f);
      await fixture.cursor(0);
      const source = await digest("fixture-import");
      for (let day = 0; day < days; day++) {
        const at = timestamp(
          new Date(Date.parse(from) + day * 86_400_000 + 3_600_000).toISOString(),
        );
        const rows = Array.from({ length: models }, (_, model) => ({
          ...summaryCounters,
          source,
          timestamp: at,
          model: `fixture-model-${model}`,
        }));
        for (let offset = 0; offset < rows.length; offset += historyBatchSize)
          await f.insert(...rows.slice(offset, offset + historyBatchSize));
      }
      await fixture.analyze();
      let reads = 0;
      const result = await poolUsageSummary(
        f.db,
        {
          pool,
          from,
          to: new Date(Date.parse(from) + days * 86_400_000).toISOString(),
          by: "model",
          authority: fixture.authority,
        },
        async () => {
          reads++;
          return prices();
        },
        Date.parse(to),
      );
      assert.equal(reads, 0);
      const overflow =
        "More than 100 provider/model pairs need prices; money estimates are unavailable.";
      for (const bucket of [
        ...result.daily,
        ...result.previousDaily,
        ...(result.models?.groups ?? []),
      ].flatMap((group) => group.buckets))
        if (bucket.details?.apiEstimate.excluded.unpriced)
          assert.equal(bucket.details.apiEstimate.reason, overflow);
      assert.ok(result.forecasts.warnings.includes(overflow));
      for (const slice of result.usageSlices) assert.equal(slice.apiReason, overflow);
      assert.equal(
        result.daily
          .flatMap((group) => group.buckets)
          .reduce((n, bucket) => n + bucket.requests, 0),
        models * days,
      );
      assert.equal(result.models?.status === "unavailable", modelOverflow);
      if (modelOverflow) {
        assert.equal(result.models?.groups.length, 0);
        assert.ok(result.models?.reason);
      }
      assert.equal(typeof result.usageSlicesUnavailableReason === "string", costOverflow);
      if (costOverflow) assert.equal(result.usageSlices.length, 0);
      assert.equal(result.partial, true);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2_097_152);
    });
  }
});

test("missing incident classification never calls unknown proof failures real", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.cursor(0);
    await f.insert({
      source: await digest("pool-gateway-v1"),
      timestamp: timestamp("2026-01-01T23:30:00Z"),
      failed: true,
      statusCode: 500,
    });
    await f.db.query("DROP TABLE basalt_model_traffic");
    const result = await poolUsageSummary(
      f.db,
      { pool, from, to, authority: fixture.authority },
      prices,
      Date.parse(to),
    );
    assert.equal(result.incidents.status, "unavailable");
    assert.equal(result.incidents.failed, 0);
    assert.equal(result.incidents.failures.length, 0);
    assert.equal(
      result.daily.flatMap((group) => group.buckets).reduce((n, bucket) => n + bucket.requests, 0),
      1,
    );
  });
});

test("incomplete capture keeps known real failures as a partial count", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.cursor(0);
    await f.insert({
      source: await digest("pool-gateway-v1"),
      timestamp: timestamp("2026-01-01T23:30:00Z"),
      failed: true,
      statusCode: 503,
    });
    await f.db.query(
      "INSERT INTO usage (id,timestamp,api_key) VALUES (1,'2026-01-01T23:45:00Z',$1)",
      [fixture.fingerprint],
    );
    const result = await poolUsageSummary(
      f.db,
      { pool, from, to, authority: fixture.authority },
      prices,
      Date.parse(to),
    );
    assert.equal(result.incidents.status, "partial");
    assert.equal(result.incidents.failed, 1);
    assert.deepEqual(result.incidents.failures, [{ status: 503, count: 1 }]);
  });
});

test("an optional incident SQL failure preserves the usage snapshot and releases its savepoint", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.native(1, "2026-01-01T01:00:00Z");
    await fixture.cursor(1);
    const fault: HistoryDatabase = {
      query: (text, values) =>
        text.includes("GROUP BY proof,failed,status_code")
          ? f.db.query("SELECT missing_summary_incident_column")
          : f.db.query(text, values),
    };
    const result = await poolUsageSummary(
      fault,
      { pool, from, to, authority: fixture.authority },
      prices,
      Date.parse(to),
    );
    assert.equal(result.incidents.status, "unavailable");
    assert.equal(result.daily[0]?.buckets[0]?.requests, 1);
    assert.equal((await f.db.query("SELECT 1 AS ready")).rows[0]?.ready, 1);
  });
});
