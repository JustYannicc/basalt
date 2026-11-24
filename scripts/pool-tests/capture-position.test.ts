import assert from "node:assert/strict";
import { test } from "node:test";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

const prices = async () => ({ prices: summaryPrices, issues: [] });
const window = { from: "2026-01-01T00:00:00Z", to: "2026-01-01T02:14:00Z" };

/**
 * The capture ingests on its own schedule (every model-history pass, about every five minutes), so
 * while calls are running the newest minutes' usage rows have no request yet: they are past the
 * capture's recorded position, not missing.
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

test("hours the capture check hasn't passed whole are not claimed complete", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    // Captured through 00:30 and nothing new since: the check reaches three missed runs ago (01:59).
    await fixture.native(1, "2026-01-01T00:30:00Z");
    await fixture.cursor(1);
    const result = await poolUsageSummary(
      f.db,
      { pool, ...window, authority: fixture.authority },
      prices,
      Date.parse(window.to),
    );
    assert.equal(result.homeCapture.status, "available");
    assert.equal(result.partial, false);
    assert.deepEqual(result.homeCapture.completeHours, ["2026-01-01T00:00:00.000Z"]);
  });
});

/** The capture runs about every five minutes: three missed runs is the bound. */
for (const [age, behind] of [
  [14, false],
  [16, true],
] as const)
  test(`an uncaptured usage row ${age} minutes old ${behind ? "reads the capture behind: its hour is missing and the summary partial" : "is the capture's normal lag: not missing, not partial"}`, async () => {
    await seriesFixture(async (f) => {
      const fixture = await summaryFixture(f);
      const now = Date.parse("2026-01-01T02:30:00Z");
      await fixture.native(1, "2026-01-01T01:00:00Z");
      // The capture's position is 20 minutes ago, further back than the row.
      await fixture.native(2, "2026-01-01T02:10:00Z");
      await fixture.cursor(2);
      await f.db.query("INSERT INTO usage (id,timestamp,api_key) VALUES (3,$1,$2)", [
        new Date(now - age * 60_000).toISOString(),
        fixture.fingerprint,
      ]);
      const result = await poolUsageSummary(
        f.db,
        {
          pool,
          from: "2026-01-01T00:00:00Z",
          to: new Date(now).toISOString(),
          authority: fixture.authority,
        },
        prices,
        now,
      );
      assert.equal(result.partial, behind);
      assert.equal(result.homeCapture.status, behind ? "partial" : "available");
    });
  });

test("a day the capture has not passed whole is not a known day, however far behind the capture is", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    // Zurich's 1 and 2 January; the capture read through the morning of the first and nothing
    // new arrived, so its position is the better part of two days old.
    const from = "2025-12-31T23:00:00Z",
      to = "2026-01-02T22:00:00Z";
    await fixture.native(1, "2026-01-01T09:00:00Z");
    await fixture.cursor(1);
    const result = await poolUsageSummary(
      f.db,
      { pool, from, to, authority: fixture.authority },
      prices,
      Date.parse(to),
    );
    assert.ok(result.historyCoverage.knownDays.includes("2026-01-01"), "1 January is passed whole");
    assert.ok(
      !result.historyCoverage.knownDays.includes("2026-01-02"),
      "2 January runs to now, past where the check reached",
    );
    assert.ok(result.historyCoverage.gapDays.includes("2026-01-02"));
  });
});
