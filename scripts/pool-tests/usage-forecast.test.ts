import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsageDays, usageDayStart } from "../../src/pool/usage-calendar.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { seriesInput } from "../../src/pool/model-history/series-input.ts";
import { authority, full, input, seriesFixture } from "./series-fixture.ts";
import { Schema } from "effect";
import {
  PoolUsageSeries,
  PoolUsageSeriesInput,
} from "../../.upstream/apps/hosted/server/src/contracts/pool-usage-series.ts";

test("Zurich days keep every imported account and unrecorded account, including DST and 429 refusals", async () => {
  await seriesFixture(async ({ db, insert }) => {
    await insert(
      { timestamp: "2026-03-28T22:59:59.999999999Z" },
      {
        timestamp: "2026-03-28T23:00:00.000000000Z",
        account: "a".repeat(64),
        statusCode: 429,
        failed: true,
      },
      { timestamp: "2026-03-29T21:59:59.999999999Z", account: "b".repeat(64) },
      { timestamp: "2026-03-29T22:00:00.000000000Z" },
    );
    const result = await poolUsageSeries(
      db,
      {
        ...input,
        from: "2026-03-28T23:00:00Z",
        to: "2026-03-29T22:00:00Z",
        bucket: "day",
        timezone: "Europe/Zurich",
      },
      authority,
    );
    const bucket = full(result.groups[0]!.buckets[0]);
    assert.equal(result.groups.length, 1);
    assert.equal(bucket.requests, 2);
    assert.equal(bucket.limited, 1);
    assert.equal(bucket.at, "2026-03-28T23:00:00.000000000Z");
    assert.equal(bucket.end, "2026-03-29T22:00:00.000000000Z");
    assert.equal(bucket.partial, false);
    const utc = await poolUsageSeries(
      db,
      { ...input, from: "2026-03-28T00:00:00Z", to: "2026-03-31T00:00:00Z", bucket: "day" },
      authority,
    );
    assert.equal(
      utc.groups[0]!.buckets.reduce((sum, day) => sum + day.requests, 0),
      4,
    );
    const autumn = await insert({ timestamp: "2026-10-25T12:00:00.000000000Z" });
    assert.equal(autumn.length, 1);
    const fall = await poolUsageSeries(
      db,
      {
        ...input,
        from: "2026-10-24T22:00:00Z",
        to: "2026-10-25T23:00:00Z",
        bucket: "day",
        timezone: "Europe/Zurich",
      },
      authority,
    );
    const day = full(fall.groups[0]!.buckets[0]);
    assert.equal(Date.parse(day.end!) - Date.parse(day.at), 25 * 3_600_000);
    assert.equal(day.partial, false);
  });
});

test("recorded provider history supplies an all-account forecast while unknown costs stay unavailable", async () => {
  await seriesFixture(async ({ db, insert }) => {
    for (let offset = 0; offset < 56; offset++) {
      const at = new Date(
        usageDayStart(addUsageDays("2026-09-14", offset)) + 12 * 3_600_000,
      ).toISOString();
      await insert(
        ...Array.from({ length: 40 }, (_, index) => ({
          timestamp: at,
          provider: index < 20 ? "claude" : "codex",
          account: index % 2 === 0 ? "a".repeat(64) : null,
          attribution: "import-owner" as const,
          totalTokens: "9007199254740993",
          tokenQuality: "legacy" as const,
        })),
      );
    }
    const result = await poolUsageSeries(
      db,
      {
        ...input,
        from: "2026-09-13T22:00:00Z",
        to: "2026-11-09T11:00:00Z",
        bucket: "day",
        by: ["provider"],
        timezone: "Europe/Zurich",
        forecast: true,
      },
      authority,
    );
    assert.equal(result.next, null);
    assert.equal(
      result.groups.reduce(
        (sum, group) => sum + group.buckets.reduce((sum, day) => sum + day.requests, 0),
        0,
      ),
      2240,
    );
    assert.equal(result.forecasts?.series.length, 3);
    const all = result.forecasts!.series.find((series) => series.provider === null)!;
    assert.equal(all.requests.status, "available");
    if (all.requests.status === "available") {
      assert.ok(Math.abs(all.requests.nextWeek.median! - 280) < 1e-9);
      assert.equal(all.requests.confidence, "Low");
      assert.equal(all.requests.misses.length, 4);
    }
    assert.equal(all.apiEstimate.status, "unavailable");
    assert.equal(all.tokens.status, "unavailable");
    assert.equal(all.excluded.apiEstimate, 2240);
    assert.equal(full(result.groups[0]!.buckets[0]).tokens.total.sum, "180143985094819860");
    assert.match(result.forecasts!.warnings.join(" "), /recorded usage/);
    const decoded = Schema.decodeUnknownSync(PoolUsageSeries)(result);
    assert.deepEqual(decoded.forecasts, result.forecasts);
  });
});

test("forecast requests reject filtered, hourly, unzoned or paged training before a database read", () => {
  const query = {
    ...input,
    bucket: "day",
    by: ["provider"],
    timezone: "Europe/Zurich",
    forecast: true,
  };
  assert.equal(seriesInput(query).forecast, true);
  const decoded = Schema.decodeUnknownSync(PoolUsageSeriesInput)(query);
  assert.equal(decoded.timezone, "Europe/Zurich");
  assert.equal(decoded.forecast, true);
  for (const change of [
    { accounts: [] },
    { sources: [] },
    { bucket: "hour" },
    { by: ["account"] },
    { timezone: "UTC" },
    { after: "cursor" },
    { timezone: "Europe/Paris" },
  ])
    assert.throws(() => seriesInput({ ...query, ...change }));
});
