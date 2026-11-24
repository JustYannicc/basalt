import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureRowCheckLimitMs,
  isRowCheck,
  rowCheckRanges,
} from "../../src/pool/model-history/capture-coverage.ts";
import { historyCaptureHoursVersion } from "../../src/pool/model-history/capture-hours-schema.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import { captureFixture, fillByTicks, hourMs } from "./capture-hours-fixture.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryPrices } from "./usage-summary-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];
const dayMs = 24 * hourMs;
const rowCheck = isRowCheck;

/**
 * Three weeks of captured requests, one missed usage row ten days ago and one fifty days ago, and
 * two uncaptured rows after the capture's position: one 20 minutes old, past #1854's bound, and one
 * 10 minutes old, inside it.
 */
async function fillData(f: Fixture, now: number) {
  const c = await captureFixture(f);
  for (let at = now - 21 * dayMs; at < now - hourMs; at += 7 * hourMs)
    await c.native(new Date(at).toISOString());
  await c.usage(new Date(now - 10 * dayMs + 1_800_000).toISOString());
  await c.usage(new Date(now - 50 * dayMs + 1_800_000).toISOString());
  const forward = Number((await f.db.query("SELECT max(id)::int AS id FROM usage")).rows[0]!.id);
  await c.cursor(forward);
  await c.usage(new Date(now - 20 * 60_000).toISOString());
  await c.usage(new Date(now - 10 * 60_000).toISOString());
  await c.ready();
  return c;
}

/** The summary over the last 14 days, with every statement it ran. */
function summarize(f: Fixture, c: Awaited<ReturnType<typeof fillData>>, now: number) {
  return async (wrap: (db: HistoryDatabase) => HistoryDatabase = (db) => db) => {
    const ran: { text: string; values?: unknown[] }[] = [];
    const recorded: HistoryDatabase = {
      query: (text, values) => {
        ran.push({ text, values });
        return f.db.query(text, values);
      },
    };
    const result = await poolUsageSummary(
      wrap(recorded),
      {
        pool,
        from: new Date(now - 14 * dayMs).toISOString(),
        to: new Date(now).toISOString(),
        authority: c.authority,
      },
      async () => ({ prices: summaryPrices, issues: [] }),
      now,
    );
    return { result, ran };
  };
}

const view = (result: Awaited<ReturnType<typeof poolUsageSummary>>) => ({
  status: result.homeCapture.status,
  completeHours: result.homeCapture.completeHours,
  knownDays: result.historyCoverage.knownDays,
  gapDays: result.historyCoverage.gapDays,
  incidents: result.incidents.status,
  partial: result.partial,
});

/** The summary without v17: the per-row check over the whole window, #1851 and #1854 as merged. */
async function withoutCounts(f: Fixture, summary: ReturnType<typeof summarize>) {
  await f.db.query("DROP TABLE basalt_model_capture_hours");
  await f.db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
    historyCaptureHoursVersion,
  ]);
  const { result, ran } = await summary();
  assert.ok(
    !ran.some((entry) => entry.text.includes("JOIN basalt_model_capture_hours")),
    "the per-row side read no stored counts",
  );
  return view(result);
}

test("with no counts yet, the summary reads exactly what it read before v17", async () => {
  await seriesFixture(async (f) => {
    const now = Date.now();
    const c = await fillData(f, now);
    const summary = summarize(f, c, now);
    const { result, ran } = await summary();
    assert.ok(ran.some((entry) => entry.text.includes("JOIN basalt_model_capture_hours")));
    assert.equal(ran.filter((entry) => rowCheck(entry.text)).length, 1, "one row check");
    const counted = view(result);
    assert.equal(counted.status, "partial", "the missed rows' hours are incomplete");
    assert.ok(counted.completeHours.length > 300, `${counted.completeHours.length} complete hours`);
    assert.deepEqual(counted, await withoutCounts(f, summary));
  });
});

test("with half the read counted, each half takes its own path and the summary reads the same", async () => {
  await seriesFixture(async (f) => {
    const now = Date.now();
    const c = await fillData(f, now);
    // Thirty days counted; the summary reads about ninety back.
    await fillByTicks(f.db, 30 * 24);
    const first = Number(
      (
        await f.db.query(
          "SELECT extract(epoch FROM date_trunc('hour',now() - interval '2 hours','UTC'))*1000 AS ms",
        )
      ).rows[0]!.ms,
    );
    const lookbackStart = first - 30 * dayMs;
    const summary = summarize(f, c, now);
    const { result, ran } = await summary();
    const read = ran.filter((entry) => rowCheck(entry.text));
    assert.equal(read.length, 1, "one row check");
    const ranges = rowCheckRanges(read[0]!.values!).map(
      (range) => [Date.parse(range.f), Date.parse(range.t)] as const,
    );
    const inCounted = ranges.filter(([from, to]) => from >= lookbackStart && to <= first);
    const missedHour = Math.floor((now - 10 * dayMs + 1_800_000) / hourMs) * hourMs;
    assert.deepEqual(
      inCounted,
      [[missedHour, missedHour + hourMs]],
      "inside the counts, only the hour whose count found a missed row",
    );
    assert.ok(
      ranges.some(([from, to]) => from < lookbackStart - 40 * dayMs && to === lookbackStart),
      "before the counts, every hour row by row up to where they start",
    );
    assert.deepEqual(view(result), await withoutCounts(f, summary));
  });
});

test("a row check past its own limit reads its hours unproven and the summary partial, and the read goes on", async () => {
  await seriesFixture(async (f) => {
    const now = Date.now();
    const c = await fillData(f, now);
    await fillByTicks(f.db, 400 * 24);
    // One day the counts lost, so the row check has that day to read besides the tail.
    const hole = Math.floor((now - 5 * dayMs) / dayMs) * dayMs;
    await f.db.query("DELETE FROM basalt_model_capture_hours WHERE hour >= $1 AND hour < $2", [
      new Date(hole).toISOString(),
      new Date(hole + dayMs).toISOString(),
    ]);
    let restored: unknown;
    let slept = 0;
    const started = performance.now();
    const { result } = await summarize(
      f,
      c,
      now,
    )((db) => ({
      query: async (text, values) => {
        if (rowCheck(text)) {
          slept++;
          // Longer than the read's own 5 s: only the row check's own limit can end it in time.
          return db.query(
            `SELECT NULL::text AS hour FROM pg_sleep(8) WHERE ${values!
              .map((_, n) => `$${n + 1}::text IS NOT NULL`)
              .join(" AND ")}`,
            values,
          );
        }
        const answer = await db.query(text, values);
        if (text.startsWith("RELEASE SAVEPOINT capture_row_check"))
          restored = (await db.query("SELECT current_setting('statement_timeout') AS t")).rows[0]!
            .t;
        return answer;
      },
    }));
    const took = performance.now() - started;
    assert.equal(slept, 1);
    assert.ok(took >= captureRowCheckLimitMs && took < 5_000 + 2_000, `took ${took} ms`);
    assert.equal(restored, "5s", "the read's own limit is back after the row check");
    assert.equal(result.homeCapture.status, "partial");
    assert.equal(result.partial, true);
    const complete = new Set(result.homeCapture.completeHours.map((at) => Date.parse(at)));
    for (let at = hole; at < hole + dayMs; at += hourMs)
      assert.ok(!complete.has(at), `${new Date(at).toISOString()} is unproven, never complete`);
    assert.ok(
      complete.has(hole - hourMs) && complete.has(hole + dayMs),
      "its counted neighbours are",
    );
    const missedHour = Math.floor((now - 10 * dayMs + 1_800_000) / hourMs) * hourMs;
    assert.ok(!complete.has(missedHour), "the counted hour with a missed row stays incomplete");
  });
});
