import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../../src/pool/backend-users.ts";
import { importAccountReference } from "../../src/pool/model-history/import-account-reference.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryCounters, summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

const from = "2026-01-01T00:00:00Z",
  to = "2026-01-02T00:00:00Z";
const prices = async () => ({ prices: summaryPrices, issues: [] });

test("all-source usage and current valuation preserve counts-only native privacy and retained billing basis", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.native(1, "2026-01-01T01:00:00Z");
    await fixture.native(2, "2026-01-01T02:00:00Z", {
      account: fixture.hidden,
      provider: "private-lab-sentinel",
      model: "private-model-sentinel",
      totalTokens: "987654321",
    });
    const imported = await digest("fixture-import");
    await f.insert(
      {
        ...summaryCounters,
        source: imported,
        timestamp: timestamp("2026-01-01T03:00:00Z"),
        account: importAccountReference(fixture.visible),
        attribution: "import-owner",
      },
      {
        ...summaryCounters,
        source: imported,
        timestamp: timestamp("2026-01-01T04:00:00Z"),
        account: await digest("foreign-account-sentinel"),
      },
      {
        ...summaryCounters,
        source: imported,
        timestamp: timestamp("2026-01-01T05:00:00Z"),
        model: null,
      },
      {
        ...summaryCounters,
        source: await digest("pool-gateway-v1"),
        timestamp: timestamp("2026-01-01T06:00:00Z"),
      },
    );
    await fixture.cursor(2);
    const result = await poolUsageSummary(
      f.db,
      { pool, from, to, by: "model", authority: fixture.authority },
      async (targets) => {
        assert.deepEqual(targets, [{ provider: "fixture-lab", model: "fixture-model-0" }]);
        return prices();
      },
      Date.parse(to),
    );
    const buckets = result.daily.flatMap((group) => group.buckets);
    assert.equal(
      buckets.reduce((n, bucket) => n + bucket.requests, 0),
      6,
    );
    assert.equal(
      buckets.reduce((n, bucket) => n + (bucket.details?.apiEstimate.pricedRequests ?? 0), 0),
      4,
    );
    assert.equal(
      buckets.reduce((n, bucket) => n + (bucket.details?.apiEstimate.excluded.unpriced ?? 0), 0),
      1,
    );
    assert.equal(result.coverage.pricing.unpriced, 5);
    assert.equal(result.coverage.pricing.importedApiPrice, 0);
    const hidden = result.daily.find((group) => group.countsOnly);
    assert.equal(hidden?.provider, null);
    assert.equal(hidden?.buckets[0]?.details, null);
    assert.equal(
      result.usageSlices.reduce((n, slice) => n + slice.apiPricedRequests, 0),
      4,
    );
    assert.ok(result.models?.groups.some((group) => group.model === null && !group.countsOnly));
    const serialized = JSON.stringify(result);
    for (const secret of [
      fixture.visible,
      fixture.hidden,
      "private-lab-sentinel",
      "private-model-sentinel",
      "987654321",
      "foreign-account-sentinel",
    ])
      assert.ok(!serialized.includes(secret));
    assert.equal(
      result.requestsByHour.reduce((n, point) => n + point.requests, 0),
      1,
    );
  });
});

test("selected and previous periods clip partial Zurich days without contaminating forecast history", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    for (const [i, at] of [
      "2026-01-01T10:00:00Z",
      "2026-01-01T13:00:00Z",
      "2026-01-02T10:00:00Z",
      "2026-01-02T13:00:00Z",
    ].entries())
      await fixture.native(i + 1, at);
    await fixture.cursor(4);
    const start = "2026-01-01T12:00:00Z",
      end = "2026-01-02T12:00:00Z";
    const result = await poolUsageSummary(
      f.db,
      { pool, from: start, to: end, authority: fixture.authority },
      prices,
      Date.parse(end),
    );
    assert.equal(
      result.daily.flatMap((group) => group.buckets).reduce((n, bucket) => n + bucket.requests, 0),
      2,
    );
    assert.equal(
      result.previousDaily
        .flatMap((group) => group.buckets)
        .reduce((n, bucket) => n + bucket.requests, 0),
      1,
    );
    assert.equal(
      Date.parse(result.previous.to) - Date.parse(result.previous.from),
      Date.parse(end) - Date.parse(start),
    );
    assert.ok(result.daily.flatMap((group) => group.buckets).every((bucket) => bucket.partial));
    assert.equal(
      result.usageSlices.reduce((n, slice) => n + slice.requests, 0),
      2,
    );
    assert.ok(Date.parse(result.readFrom) < Date.parse(start));
  });
});

test("Zurich DST buckets and the comparison preserve calendar boundaries", async () => {
  for (const [start, end, hours] of [
    ["2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z", 23],
    ["2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z", 25],
  ] as const) {
    await seriesFixture(async (f) => {
      const fixture = await summaryFixture(f);
      await fixture.native(1, new Date(Date.parse(start) + 3_600_000).toISOString());
      await fixture.cursor(1);
      const result = await poolUsageSummary(
        f.db,
        { pool, from: start, to: end, authority: fixture.authority },
        prices,
        Date.parse(end),
      );
      const bucket = result.daily[0]?.buckets[0];
      assert.ok(bucket);
      assert.equal((Date.parse(bucket.end) - Date.parse(bucket.at)) / 3_600_000, hours);
      assert.equal(bucket.partial, false);
      assert.equal(Date.parse(result.previous.to), Date.parse(start));
      assert.equal(
        (Date.parse(result.previous.to) - Date.parse(result.previous.from)) / 3_600_000,
        24,
      );
      assert.equal(result.homeCapture.completeHours.length, hours);
    });
  }
});

test("an uncaptured same-day native request makes coverage and projections explicit", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.native(1, "2026-01-01T01:00:00Z");
    await fixture.cursor(1);
    await f.db.query(
      "INSERT INTO usage (id,timestamp,api_key) VALUES (2,'2026-01-01T02:30:00Z',$1)",
      [fixture.fingerprint],
    );
    const result = await poolUsageSummary(
      f.db,
      { pool, from, to, authority: fixture.authority },
      prices,
      Date.parse(to),
    );
    assert.equal(result.partial, true);
    assert.equal(result.homeCapture.status, "partial");
    assert.ok(
      !result.homeCapture.completeHours.some(
        (at) => Date.parse(at) === Date.parse("2026-01-01T02:00:00Z"),
      ),
    );
    assert.ok(result.forecasts.warnings.some((warning) => warning.includes("uncaptured")));
  });
});

test("incidents always read the live hour and exclude proof traffic and client cancellations", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.cursor(0);
    const gateway = await digest("pool-gateway-v1"),
      proofKey = await digest("fixture-proof-key");
    const at = timestamp("2026-02-01T00:30:00Z");
    await f.insert(
      { source: gateway, timestamp: at, failed: true, statusCode: 503 },
      { source: gateway, timestamp: at, failed: true, statusCode: 499 },
      { source: gateway, timestamp: at, failed: true, statusCode: 500, clientKey: proofKey },
      {
        source: gateway,
        timestamp: timestamp("2026-01-31T23:30:00Z"),
        failed: true,
        statusCode: 504,
      },
    );
    await f.db.query(
      "INSERT INTO basalt_model_traffic (pool,source,client_key,purpose,evidence) VALUES ($1,$2,$3,'proof',$4)",
      [(await digest(pool)).slice(0, 16), gateway, proofKey, "a".repeat(64)],
    );
    const result = await poolUsageSummary(
      f.db,
      { pool, from, to, authority: fixture.authority },
      prices,
      Date.parse("2026-02-01T01:00:00Z"),
    );
    assert.equal(result.incidents.status, "available");
    assert.equal(result.incidents.requests, 1);
    assert.equal(result.incidents.failed, 1);
    assert.deepEqual(result.incidents.failures, [{ status: 503, count: 1 }]);
    assert.equal(Date.parse(result.incidents.to), Date.parse("2026-02-01T01:00:00Z"));
    assert.equal(result.daily.length, 0);
  });
});
