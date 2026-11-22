import assert from "node:assert/strict";
import { test } from "node:test";
import { signEnvelope } from "../../src/pool/token.ts";
import {
  handleUsageSeries,
  poolUsageSummaryPath,
} from "../../src/pool/model-history/series-http.ts";
import { maxSummaryWindowRows } from "../../src/pool/model-history/summary-query.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture } from "./usage-summary-fixture.ts";

const signingKey = "ab".repeat(32);

test("a summary window one row over the real bound refuses fast and is logged and reported as history_too_large", async (t) => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.native(1, "2026-01-01T01:00:00Z");
    await fixture.cursor(1);
    // Copy the one native row until the window holds one more than the bound, as an import would.
    const columns = (
      await f.db.query(
        `SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='basalt_model_requests'
          AND column_name NOT IN ('id','source_record') ORDER BY ordinal_position`,
      )
    ).rows.map((row) => `"${String(row.column_name)}"`);
    await f.db.query(
      `INSERT INTO basalt_model_requests (id,source_record,${columns.join(",")})
      SELECT encode(sha256(convert_to('bound-id-'||n,'UTF8')),'hex'),
        encode(sha256(convert_to('bound-record-'||n,'UTF8')),'hex'),${columns.map((c) => `seed.${c}`).join(",")}
      FROM (SELECT * FROM basalt_model_requests LIMIT 1) seed
      CROSS JOIN generate_series(1,$1::int) n`,
      [maxSummaryWindowRows],
    );
    await f.db.query("ANALYZE basalt_model_requests");
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.set("options", `-c search_path=${f.schema}`);
    const reported: string[] = [];
    const errors = t.mock.method(console, "error", () => {});
    t.mock.method(console, "info", () => {});
    const started = performance.now();
    const response = await handleUsageSeries(
      new Request(`https://pool.example.test${poolUsageSummaryPath}`, {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(signingKey, "sbs1", {
            action: "poolUsageSummary",
            pool,
            user: "fixture-manager",
            organization: "fixture-organization",
            expiresAt: Date.now() + 30_000,
            input: {
              pool,
              from: "2026-01-01T00:00:00Z",
              to: "2026-01-02T00:00:00Z",
              authority: fixture.authority,
            },
          }),
        }),
      }),
      {
        signingKey,
        connectionString: url.href,
        failed: (action: string) => reported.push(action),
      },
    );
    const elapsed = performance.now() - started;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "history_too_large",
      message: "This pool's usage history is too large to summarize in one read yet.",
    });
    assert.ok(elapsed < 3_000, `answered after ${Math.round(elapsed)} ms`);
    const lines = errors.mock.calls
      .filter((call) => call.arguments[0] === "POOL_USAGE_READ_FAILED")
      .map((call) => JSON.parse(String(call.arguments[1])) as Record<string, unknown>);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.action, "poolUsageSummary");
    assert.equal(lines[0]!.failure, "history_too_large");
    // The count statement succeeded, so no statement takes the blame.
    assert.equal(lines[0]!.statement, undefined);
    assert.deepEqual(reported, ["poolUsageSummary"]);
  });
});
