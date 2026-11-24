import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryCaptureLagMs, poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { captureHoursLookbackHours } from "../../src/pool/model-history/capture-hours-plan.ts";
import { at, captureFixture, fillByTicks, hourMs } from "./capture-hours-fixture.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryPrices } from "./usage-summary-fixture.ts";

/**
 * v17's stored counts prove the settled hours, and the capture's position bounds the per-row check
 * of the tail: in one summary, a settled hour reads complete from its counts, a usage row inside
 * the capture's normal lag is not missing, and one just past it makes its hour missing.
 */
test("stored counts prove the settled hours while the tail's check ends at the capture's lag bound", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    // A quarter past an hour that has begun, so the rows 16 and 14 minutes before it sit in
    // different hours, both after the settle horizon two hours behind the database's clock.
    let now = Math.floor(Date.now() / hourMs) * hourMs + summaryCaptureLagMs;
    if (now > Date.now()) now -= hourMs;
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const lastHour = Math.floor((now - 16 * 60_000) / hourMs) * hourMs;
    // Settled hours with captured requests, and one captured 20 minutes ago: the capture's position.
    await c.native(at(1, 600_000));
    await c.native(at(5, 600_000));
    await c.native(minutesAgo(20));
    const forward = Number((await f.db.query("SELECT max(id)::int AS id FROM usage")).rows[0]!.id);
    await c.cursor(forward);
    // Not captured yet: one past the 15-minute lag, one inside it.
    await c.usage(minutesAgo(16));
    await c.usage(minutesAgo(14));
    await c.ready();
    // The summary reads well before its window, so every hour it reads needs its count.
    await fillByTicks(f.db, captureHoursLookbackHours);

    const ran: { text: string; values?: unknown[]; rows: Record<string, unknown>[] }[] = [];
    const recorded = {
      query: async (text: string, values?: unknown[]) => {
        const result = await f.db.query(text, values);
        ran.push({ text, values, rows: result.rows });
        return result;
      },
    };
    const result = await poolUsageSummary(
      recorded,
      { pool, from: at(0), to: new Date(now).toISOString(), authority: c.authority },
      async () => ({ prices: summaryPrices, issues: [] }),
      now,
    );

    assert.ok(
      ran.some((entry) => entry.text.includes("JOIN basalt_model_capture_hours")),
      "the summary read the stored counts",
    );
    const rowCheck = ran.filter((entry) => entry.text.includes("AS w(f text, t text)"));
    assert.equal(rowCheck.length, 1, "one per-row check of the tail");
    const ranges = JSON.parse(String(rowCheck[0]!.values![1])) as { f: string; t: string }[];
    assert.ok(
      ranges.every((range) => Date.parse(range.f) >= lastHour - hourMs),
      `the per-row check reads no settled hour: ${JSON.stringify(ranges)}`,
    );
    assert.equal(
      Math.max(...ranges.map((range) => Date.parse(range.t))),
      now - summaryCaptureLagMs,
      "the per-row check ends at the lag bound, before the row 14 minutes old",
    );
    assert.deepEqual(
      rowCheck[0]!.rows.map((row) => row.hour),
      [new Date(lastHour).toISOString().replace(".000Z", "Z")],
      "only the row 16 minutes old is missing",
    );

    assert.equal(result.partial, true, "the capture is behind on the row 16 minutes old");
    assert.equal(result.homeCapture.status, "partial");
    const expected: string[] = [];
    for (let hour = Date.parse(at(0)); hour < lastHour; hour += hourMs)
      expected.push(new Date(hour).toISOString());
    assert.ok(
      expected.includes(at(1)) && expected.includes(at(5)),
      "the settled hours are checked",
    );
    assert.deepEqual(
      result.homeCapture.completeHours,
      expected,
      "every hour before the missing one is complete, from its counts or the tail's check",
    );
  });
});
