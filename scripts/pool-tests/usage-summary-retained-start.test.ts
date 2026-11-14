import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../../src/pool/backend-users.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryCounters, summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

const from = "2026-11-13T00:00:00Z";
const to = "2026-11-14T00:00:00Z";

test("the retained start belongs to this pool outside the selected and training ranges", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.cursor(0);
    const first = timestamp("2026-05-31T21:59:59.999999999Z");
    await f.insert(
      { ...summaryCounters, timestamp: first },
      { ...summaryCounters, timestamp: timestamp("2026-05-31T22:00:00.000000001Z") },
      {
        ...summaryCounters,
        pool: (await digest("another-pool")).slice(0, 16),
        timestamp: timestamp("2026-01-01T00:00:00Z"),
      },
    );
    const result = await poolUsageSummary(
      f.db,
      { pool, from, to, authority: fixture.authority },
      async () => ({ prices: summaryPrices, issues: [] }),
      Date.parse(to),
    );
    assert.equal(result.coverage.firstAt, null);
    assert.equal(result.retainedFirstAt, first);
    assert.ok(result.readFrom > first);
    assert.equal(result.daily.length, 0);
  });
});

test("an empty pool has no retained start", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.cursor(0);
    const result = await poolUsageSummary(
      f.db,
      { pool, from, to, authority: fixture.authority },
      async () => ({ prices: summaryPrices, issues: [] }),
      Date.parse(to),
    );
    assert.equal(result.retainedFirstAt, null);
  });
});

test("an overfull first timestamp bucket leaves the exact retained start unknown", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.cursor(0);
    for (const count of [200, 200, 200, 200, 200, 1]) {
      await f.insert(
        ...Array.from({ length: count }, () => ({
          ...summaryCounters,
          timestamp: timestamp("2026-05-01T00:00:00Z"),
        })),
      );
    }
    const result = await poolUsageSummary(
      f.db,
      { pool, from, to, authority: fixture.authority },
      async () => ({ prices: summaryPrices, issues: [] }),
      Date.parse(to),
    );
    assert.equal(result.retainedFirstAt, null);
  });
});
