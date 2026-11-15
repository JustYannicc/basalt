import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolUsageSummaryResult } from "../../apps/pool/usage-overview-contract.ts";
import { summaryInput } from "../../src/pool/model-history/summary-input.ts";
import {
  handleUsageSeries,
  poolUsageSummaryPath,
} from "../../src/pool/model-history/series-http.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { summaryFixture, summaryPrices } from "./usage-summary-fixture.ts";

const from = "2026-01-01T00:00:00Z",
  to = "2026-01-02T00:00:00Z";

test("a signed summary HTTP read returns retained native and imported usage through the real database adapter", async () => {
  await seriesFixture(async (f) => {
    const fixture = await summaryFixture(f);
    await fixture.native(1, "2026-01-01T01:00:00Z");
    await fixture.cursor(1);
    await f.insert({ model: null, inputTokens: "9007199254740993" });
    const connection = new URL(process.env.POOL_TEST_ADMIN_URL!);
    connection.searchParams.set("options", `-c search_path=${f.schema}`);
    const signingKey = "ab".repeat(32);
    const response = await handleUsageSeries(
      new Request(`https://pool.example.test${poolUsageSummaryPath}`, {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(signingKey, "sbs1", {
            action: "poolUsageSummary",
            pool,
            user: "fixture-manager",
            organization: "fixture-org",
            expiresAt: Date.now() + 30_000,
            input: { pool, from, to, authority: fixture.authority },
          }),
        }),
      }),
      {
        signingKey,
        connectionString: connection.toString(),
        currentPrices: async () => ({ prices: summaryPrices, issues: [] }),
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const result: PoolUsageSummaryResult = await response.json();
    assert.equal(
      result.daily.flatMap((group) => group.buckets).reduce((n, bucket) => n + bucket.requests, 0),
      2,
    );
    assert.equal(
      result.usageSlices.reduce((n, slice) => n + slice.apiPricedRequests, 0),
      1,
    );
    assert.ok(JSON.stringify(result).includes("9007199254740993"));
    assert.ok(!JSON.stringify(result).includes(fixture.visible));
  });
});

test("the summary assertion rejects non-managers, wrong actions and invalid bounds before database access", async () => {
  const signingKey = "ab".repeat(32);
  const request = async (changes: Record<string, unknown> = {}) =>
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
            from,
            to,
            authority: { canManage: true, mappingProven: true, accounts: [] },
          },
          ...changes,
        }),
      }),
    });
  const access = { signingKey, connectionString: undefined };
  assert.equal(
    (
      await handleUsageSeries(
        await request({ input: { pool, from, to, authority: { canManage: false, accounts: [] } } }),
        access,
      )
    ).status,
    403,
  );
  assert.equal(
    (await handleUsageSeries(await request({ action: "poolOverview" }), access)).status,
    401,
  );
  assert.equal(
    (
      await handleUsageSeries(
        await request({
          input: { pool, from: to, to: from, authority: { canManage: true, accounts: [] } },
        }),
        access,
      )
    ).status,
    400,
  );
  assert.throws(() => summaryInput({ pool, from, to, by: "account" }));
});
