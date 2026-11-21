import assert from "node:assert/strict";
import { test } from "node:test";
import { failureResponse } from "../../src/pool/json.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { historySeriesFailure } from "../../src/pool/model-history/series-diagnostics.ts";
import { poolUsageSummary } from "../../src/pool/model-history/summary.ts";
import {
  maxSummaryWindowRows,
  summaryPriceTargets,
  summarySelection,
} from "../../src/pool/model-history/summary-query.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

const from = "2026-01-01T00:00:00Z",
  to = "2026-01-02T00:00:00Z";

test("a window over the row bound refuses after one bounded count, before any aggregate scan runs", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    for (let id = 1; id <= 4; id++)
      await fixture.native(id, `2026-01-01T0${id}:00:00Z`, { model: `fixture-model-${id % 2}` });
    await fixture.cursor(4);
    await fixture.analyze();
    const statements: string[] = [];
    const counted: HistoryDatabase = {
      query: (text, values) => {
        statements.push(text);
        return f.db.query(text, values);
      },
    };
    const input = { pool, from, to, authority: fixture.authority };
    let priceReads = 0;
    const prices = async () => {
      priceReads++;
      return { prices: summaryPrices, issues: [] };
    };
    const refusal = await poolUsageSummary(counted, input, prices, Date.parse(to), 3).then(
      () => assert.fail("A window over its bound must refuse"),
      (error: unknown) => error,
    );
    assert.equal(historySeriesFailure(refusal), "history_too_large");
    const response = failureResponse(refusal);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "history_too_large",
      message: "This pool's usage history is too large to summarize in one read yet.",
    });
    // BEGIN, SET LOCAL, the gated targets statement, ROLLBACK: no coverage, daily or hourly scan.
    assert.equal(statements.length, 4, statements.join("\n---\n"));
    assert.equal(priceReads, 0);

    // The gate is a one-time filter: over the bound the targets scan never executes, and the count
    // itself stops one row past the bound.
    const selection = await summarySelection(pool, "2025-10-01T00:00:00Z", to, fixture.authority);
    const query = summaryPriceTargets(selection, 3);
    const plan = (await f.db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.text}`, query.values))
      .rows[0]!["QUERY PLAN"] as { Plan: PlanNode }[];
    const nodes = flatten(plan[0]!.Plan);
    const historyScans = nodes.filter(
      (node) => node["Relation Name"]?.startsWith("basalt_model_requests") === true,
    );
    const scanned = historyScans.reduce((n, node) => n + (node["Actual Rows"] ?? 0), 0);
    assert.ok(scanned <= 4, `history scans returned ${scanned} rows`);
    const gate = nodes.find((node) => node["One-Time Filter"] !== undefined);
    assert.ok(gate, JSON.stringify(plan));
    assert.equal(gate["Actual Rows"], 0);
    assert.ok((gate.Plans ?? []).length > 0);
    assert.ok(
      flatten(gate)
        .slice(1)
        .every((node) => node["Actual Loops"] === 0),
    );

    // At or under the bound the summary answers as before, in the same fifteen statements.
    statements.length = 0;
    const result = await poolUsageSummary(counted, input, prices, Date.parse(to), 4);
    assert.equal(
      result.daily.flatMap((group) => group.buckets).reduce((n, bucket) => n + bucket.requests, 0),
      4,
    );
    assert.equal(statements.length, 15);
    assert.ok(maxSummaryWindowRows >= 100_000);
  });
});

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "One-Time Filter"?: string;
  Plans?: PlanNode[];
}
function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}
