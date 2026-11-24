import assert from "node:assert/strict";
import { test } from "node:test";
import {
  homeCaptureCoverage,
  isRowCheck,
  maxRowCheckRanges,
  mergeRanges,
  rowCheckRanges,
  rowCheckStatement,
} from "../../src/pool/model-history/capture-coverage.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import {
  blockPositions,
  captureFixture,
  clockAt,
  fillByTicks,
  hourMs,
  recording,
} from "./capture-hours-fixture.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryPrices } from "./usage-summary-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];
const dayMs = 24 * hourMs;
const iso = (at: number) => new Date(at).toISOString();

/** The row check replaced by a sleep longer than the read's own 5 s: only its own limit ends it. */
const timingOut = (db: HistoryDatabase): HistoryDatabase => ({
  query: (text, values) =>
    isRowCheck(text)
      ? db.query(
          `SELECT NULL::text AS hour FROM pg_sleep(8) WHERE ${values!
            .map((_, n) => `$${n + 1}::text IS NOT NULL`)
            .join(" AND ")}`,
          values,
        )
      : db.query(text, values),
});

for (const position of blockPositions())
  test(`a row check past its own limit keeps every hour the counts proved complete and reads partial, however many hours it covered (${position.label})`, async () => {
    await seriesFixture(async (f) => {
      await clockAt(f, position.at);
      const now = position.at;
      const c = await captureFixture(f);
      for (let at = now - 21 * dayMs; at < now - hourMs; at += 7 * hourMs) await c.native(iso(at));
      const forward = Number(
        (await f.db.query("SELECT max(id)::int AS id FROM usage")).rows[0]!.id,
      );
      await c.cursor(forward);
      await c.ready();
      // Thirty days counted; the summary reads about ninety back, so its row check covers some
      // 1,400 uncounted hours, more than the 800 a check may name.
      await fillByTicks(f.db, 30 * 24);
      const from = now - 14 * dayMs;
      const result = await poolUsageSummary(
        timingOut(f.db),
        { pool, from: iso(from), to: iso(now), authority: c.authority },
        async () => ({ prices: summaryPrices, issues: [] }),
        now,
      );
      assert.equal(result.homeCapture.status, "partial", "partial, never unavailable");
      assert.equal(result.partial, true);
      const horizon = Math.floor((now - 2 * hourMs) / hourMs) * hourMs;
      const complete = new Set(result.homeCapture.completeHours.map((at) => Date.parse(at)));
      for (let at = Math.ceil(from / hourMs) * hourMs; at < horizon; at += hourMs)
        assert.ok(complete.has(at), `${iso(at)}, proven by its count, stays complete`);
      for (let at = horizon; at + hourMs <= now; at += hourMs)
        assert.ok(!complete.has(at), `${iso(at)}, left to the timed-out check, is unproven`);
      assert.ok(
        result.historyCoverage.knownDays.length > 0,
        "the days the counts proved are known",
      );
    });
  });

test("the row check is one statement with a branch per range and each range's bounds as parameters", () => {
  const text = rowCheckStatement(3);
  assert.ok(isRowCheck(text));
  assert.ok(!text.includes("jsonb"), "no list of ranges for the planner to guess at");
  assert.equal(text.split("UNION ALL").length, 3, "a branch per range");
  for (const n of [4, 5, 6, 7, 8, 9]) assert.ok(text.includes(`$${n}::timestamptz`), `$${n}`);
  assert.ok(!text.includes("$10"), "no parameter past the last range");
  assert.deepEqual(rowCheckRanges(["p", "pool", "source", "a", "b", "c", "d"]), [
    { f: "a", t: "b" },
    { f: "c", t: "d" },
  ]);
});

test("past its cap the closest ranges merge, covering every range and nothing before or after them", () => {
  const start = Date.parse("2026-11-01T00:00:00Z");
  // Forty one-hour ranges, the gap after the n-th one n + 1 hours long.
  const ranges: { f: string; t: string }[] = [];
  for (let n = 0, at = start; n < 40; at += (n + 2) * hourMs, n++)
    ranges.push({ f: iso(at), t: iso(at + hourMs) });
  const merged = mergeRanges(ranges);
  assert.equal(merged.length, maxRowCheckRanges);
  assert.equal(merged[0]!.f, ranges[0]!.f);
  assert.equal(merged.at(-1)!.t, ranges.at(-1)!.t);
  for (const range of ranges)
    assert.ok(
      merged.some(
        (into) =>
          Date.parse(into.f) <= Date.parse(range.f) && Date.parse(range.t) <= Date.parse(into.t),
      ),
      `${range.f} is covered`,
    );
  // The eight smallest gaps are the first eight: the first nine ranges became one.
  assert.deepEqual(merged[0], { f: ranges[0]!.f, t: ranges[8]!.t });
  assert.deepEqual(mergeRanges(ranges.slice(0, 5)), ranges.slice(0, 5), "under the cap, unchanged");
});

test("forty scattered hours with a missed row are found in one capped row check, exactly", async () => {
  await seriesFixture(async (f) => {
    const now = Date.now();
    const c = await captureFixture(f);
    const base = Math.floor((now - 30 * dayMs) / hourMs) * hourMs;
    await c.native(iso(base - dayMs));
    // Forty counted hours apart from each other, each with a usage row whose request is missing.
    const missed: string[] = [];
    for (let n = 0; n < 40; n++) {
      const at = base + n * 13 * hourMs;
      await c.usage(iso(at + 60_000));
      missed.push(iso(at).replace(".000Z", "Z"));
    }
    const forward = Number((await f.db.query("SELECT max(id)::int AS id FROM usage")).rows[0]!.id);
    await c.cursor(forward);
    await c.ready();
    await fillByTicks(f.db, 60 * 24);
    const read = recording(f.db);
    await f.db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const result = await homeCaptureCoverage(
        read.db,
        c.poolId,
        c.source,
        iso(base - 2 * dayMs),
        iso(now - 3 * hourMs),
        true,
      );
      const checks = read.seen.filter((entry) => isRowCheck(entry.text));
      assert.equal(checks.length, 1, "one row check");
      assert.ok(
        rowCheckRanges(checks[0]!.values!).length <= maxRowCheckRanges,
        "its branches are capped",
      );
      assert.deepEqual([...result.incompleteHours!].sort(), missed.sort());
    } finally {
      await f.db.query("ROLLBACK");
    }
  });
});

/** The planner's estimate of the usage rows a statement reads, summed over its usage scans. */
async function usageEstimate(f: Fixture, text: string, values: unknown[]) {
  const plan = (await f.db.query(`EXPLAIN (FORMAT JSON) ${text}`, values)).rows[0]![
    "QUERY PLAN"
  ] as { Plan: PlanNode }[];
  let rows = 0;
  const visit = (node: PlanNode) => {
    if (node["Relation Name"] === "usage") rows += node["Plan Rows"] * (node["Actual Loops"] ?? 1);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan[0]!.Plan);
  return rows;
}
interface PlanNode {
  "Relation Name"?: string;
  "Plan Rows": number;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
}

/**
 * With its ranges in a JSON list, the planner guessed each range's rows (200), so it never chose a
 * parallel plan for the row check, and production's first load after the release took twice what
 * the statement before v17 took. With each range's bounds as parameters it estimates the rows as it
 * does for that statement, and so chooses the same kind of plan.
 */
test("the planner estimates the row check's usage rows as it does the statement before v17's", async () => {
  await seriesFixture(async (f) => {
    const c = await captureFixture(f);
    const from = Date.parse("2026-09-01T00:00:00Z");
    await f.db.query(
      `INSERT INTO usage (id,timestamp,api_key)
      SELECT n, $1::timestamptz + n * interval '3 minutes', $2 FROM generate_series(1,40000) n`,
      [iso(from), c.fingerprint],
    );
    await c.ready();
    await c.analyze();
    const read = recording(f.db);
    const to = iso(from + 80 * dayMs);
    await homeCaptureCoverage(read.db, c.poolId, c.source, iso(from), to, false);
    const before = read.seen.find((entry) =>
      entry.text.includes("u.timestamp >= $2::timestamptz"),
    )!;
    const window = await usageEstimate(f, before.text, before.values!);
    assert.ok(window > 30_000, `the statement before v17 expects the window's rows: ${window}`);
    const values = [before.values![0], c.poolId, c.source, iso(from), to];
    const checked = await usageEstimate(f, rowCheckStatement(1), values);
    assert.ok(
      Math.abs(checked - window) <= window * 0.1,
      `the row check expects them too: ${checked} against ${window}`,
    );
  });
});
