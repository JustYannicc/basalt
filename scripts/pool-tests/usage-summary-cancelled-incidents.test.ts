import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolUsageSummaryResult } from "../../apps/pool/usage-overview-contract.ts";
import {
  handleUsageSeries,
  poolUsageSummaryPath,
} from "../../src/pool/model-history/series-http.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

test("a statement Postgres cancels in the optional incidents step degrades incidents and the summary still answers", async (t) => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.native(1, "2026-01-01T01:00:00Z");
    await fixture.cursor(1);
    const connection = new URL(process.env.POOL_TEST_ADMIN_URL!);
    connection.searchParams.set("options", `-c search_path=${f.schema}`);
    const signingKey = "ab".repeat(32);
    // Only the incidents step reads the traffic table, so only its statement waits out the 5 s
    // statement timeout, as a long write or migration holding that table would make it.
    const errors = t.mock.method(console, "error", () => {});
    t.mock.method(console, "info", () => {});
    await f.db.query("BEGIN");
    await f.db.query("LOCK TABLE basalt_model_traffic IN ACCESS EXCLUSIVE MODE");
    let response: Response;
    try {
      response = await handleUsageSeries(
        new Request(`https://pool.example.test${poolUsageSummaryPath}`, {
          method: "POST",
          body: JSON.stringify({
            envelope: await signEnvelope(signingKey, "sbs1", {
              action: "poolUsageSummary",
              pool,
              user: "fixture-manager",
              organization: "fixture-org",
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
          connectionString: connection.toString(),
          currentPrices: async () => ({ prices: summaryPrices, issues: [] }),
        },
      );
    } finally {
      await f.db.query("ROLLBACK");
    }
    assert.equal(response.status, 200, await response.clone().text());
    const result: PoolUsageSummaryResult = await response.json();
    assert.equal(result.incidents.status, "unavailable");
    // A cancel the incidents savepoint recovered is not a failed read: no failure line is logged.
    assert.equal(
      errors.mock.calls.filter((call) => call.arguments[0] === "POOL_USAGE_READ_FAILED").length,
      0,
    );
    assert.equal(
      result.daily.flatMap((group) => group.buckets).reduce((n, bucket) => n + bucket.requests, 0),
      1,
    );
  });
});
