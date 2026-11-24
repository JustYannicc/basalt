import assert from "node:assert/strict";
import { test } from "node:test";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

const prices = async () => ({ prices: summaryPrices, issues: [] });
const window = { from: "2026-01-01T00:00:00Z", to: "2026-01-01T02:14:00Z" };

/**
 * The capture ingests on its own schedule (every model-history pass) and the availability probe
 * writes about one usage row a minute, so the newest minutes' rows have no request yet: they are
 * past the capture's recorded position, not missing.
 */
test("a usage row newer than the capture's recorded position is not a missing hour, and the summary does not read partial", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.native(1, "2026-01-01T01:00:00Z");
    await fixture.native(2, "2026-01-01T02:10:00Z");
    // Captured through usage row 2; row 3 landed after it and the next capture hasn't run yet.
    await fixture.cursor(2);
    await f.db.query(
      "INSERT INTO usage (id,timestamp,api_key) VALUES (3,'2026-01-01T02:13:00Z',$1)",
      [fixture.fingerprint],
    );
    const result = await poolUsageSummary(
      f.db,
      { pool, ...window, authority: fixture.authority },
      prices,
      Date.parse(window.to),
    );
    assert.equal(result.partial, false, "nothing failed and nothing was missed");
    assert.equal(result.homeCapture.status, "available");
    assert.deepEqual(result.homeCapture.completeHours, [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T01:00:00.000Z",
    ]);
  });
});

test("a usage row older than the capture's recorded position with no request is still a missing hour", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.native(1, "2026-01-01T01:00:00Z");
    await f.db.query(
      "INSERT INTO usage (id,timestamp,api_key) VALUES (2,'2026-01-01T01:30:00Z',$1)",
      [fixture.fingerprint],
    );
    await fixture.native(3, "2026-01-01T02:10:00Z");
    await fixture.cursor(3);
    const result = await poolUsageSummary(
      f.db,
      { pool, ...window, authority: fixture.authority },
      prices,
      Date.parse(window.to),
    );
    assert.equal(result.partial, true);
    assert.equal(result.homeCapture.status, "partial");
    assert.deepEqual(result.homeCapture.completeHours, ["2026-01-01T00:00:00.000Z"]);
  });
});

test("hours after the capture's recorded position are not claimed complete, however far behind it is", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.native(1, "2026-01-01T00:30:00Z");
    await fixture.cursor(1);
    // Rows the capture hasn't reached: they are not missing, and their hours are not complete.
    for (const [id, at] of [
      [2, "2026-01-01T01:10:00Z"],
      [3, "2026-01-01T01:50:00Z"],
    ] as const)
      await f.db.query("INSERT INTO usage (id,timestamp,api_key) VALUES ($1,$2,$3)", [
        id,
        at,
        fixture.fingerprint,
      ]);
    const result = await poolUsageSummary(
      f.db,
      { pool, ...window, authority: fixture.authority },
      prices,
      Date.parse(window.to),
    );
    assert.equal(result.homeCapture.status, "available");
    assert.deepEqual(
      result.homeCapture.completeHours,
      [],
      "no hour the capture hasn't passed whole",
    );
    assert.equal(result.partial, false);
  });
});
