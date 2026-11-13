import assert from "node:assert/strict";
import { test } from "node:test";
import { callerHeader } from "../../apps/pool/contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { handleModelHistory } from "../../src/pool/model-history/http.ts";
import { readPricedRequests } from "../../src/pool/model-history/priced-history.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { pool, seriesFixture } from "./series-fixture.ts";

const signingKey = "cd".repeat(32);
const from = "2026-01-01T00:00:00Z",
  to = "2026-01-02T00:00:00Z";
const prices = [
  {
    provider: "claude",
    model: "fixture-model",
    currency: "USD" as const,
    input: "4",
    output: "20",
    cacheRead: "0.2",
    cacheWrite: "5",
    request: "0",
    tier: "*",
    minInput: "0",
    source: "models.dev" as const,
    version: "fixture-rates",
    asOf: "2026-01-01T00:00:00Z",
    basis: "baseline" as const,
  },
];

test("public request HTTP prices retained counters in USD while preserving charges and caller scope", async () => {
  await seriesFixture(async (f) => {
    const source = await digest("home-local-v1"),
      person = await digest("fixture-member");
    const rows = await f.insert(
      {
        source,
        person,
        provider: "claude",
        model: "fixture-model",
        tokenQuality: "legacy",
        inputTokens: "1000",
        outputTokens: "200",
        cacheReadTokens: "400",
        cacheWriteTokens: "100",
        reasoningTokens: "50",
        totalTokens: "1750",
        cost: "7",
        currency: "credits",
        costBasis: "home-charge",
      },
      {
        source,
        person,
        provider: "claude",
        model: "fixture-model",
        tokenQuality: "complete",
        failed: true,
        inputTokens: "1500",
        outputTokens: "250",
        cacheReadTokens: "400",
        cacheWriteTokens: "100",
        totalTokens: "1750",
      },
      {
        source,
        person,
        provider: "claude",
        model: "fixture-model",
        tokenQuality: "complete",
        failed: true,
        inputTokens: "0",
        outputTokens: "0",
        cacheReadTokens: "0",
        cacheWriteTokens: "0",
        totalTokens: "0",
      },
      {
        source,
        person,
        provider: "claude",
        model: "missing-model",
        inputTokens: "100",
        outputTokens: "10",
        cacheReadTokens: "0",
        cacheWriteTokens: "0",
        tokenQuality: "complete",
      },
      {
        source,
        person: await digest("another-member"),
        provider: "claude",
        model: "private-other-model",
      },
      { source, person, pool: "f".repeat(16), provider: "claude", model: "private-other-pool" },
    );
    const before = (
      await f.db.query(
        "SELECT md5(string_agg(row_to_json(r)::text,',' ORDER BY id)) AS hash FROM basalt_model_requests r",
      )
    ).rows[0]?.hash;
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.set("options", `-c search_path=${f.schema}`);
    const targets: unknown[] = [];
    const token = await signPoolToken(signingKey, {
      pool,
      owner: "fixture-manager",
      organization: "fixture-organization",
    });
    const access = {
      signingKey,
      connectionString: url.toString(),
      permissions: async () => ({ canUse: true, canManage: false }),
      currentPrices: async (wanted: readonly { provider: string; model: string }[]) => {
        targets.push(wanted);
        return { prices, issues: [] };
      },
    };
    const request = (after?: unknown) => {
      const query = new URLSearchParams({ from, to });
      if (after) query.set("after", JSON.stringify(after));
      return new Request(`https://pool.example.test/pool/v1/usage/history?${query}`, {
        headers: { authorization: `Bearer ${token}`, [callerHeader]: "fixture-member" },
      });
    };
    const response = await handleModelHistory(request(), access);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.records.length, 4);
    const legacy = body.records.find((r: { id: string }) => r.id === rows[0]!.id);
    assert.equal(legacy.api_estimate?.amount, "0.009580000000");
    assert.equal(legacy.api_estimate?.currency, "USD");
    assert.equal(legacy.api_estimate?.price.calculation, "token-counts");
    assert.equal(legacy.api_estimate?.price.version, "fixture-rates");
    assert.equal(legacy.cost, "7.000000000000");
    assert.equal(legacy.currency, "credits");
    const canonical = body.records.find((r: { id: string }) => r.id === rows[1]!.id);
    assert.equal(canonical.api_estimate?.amount, "0.009580000000");
    assert.equal(canonical.api_estimate?.price.calculation, undefined);
    assert.equal(
      body.records.find((r: { id: string }) => r.id === rows[2]!.id).api_estimate?.amount,
      "0.000000000000",
    );
    const unknown = body.records.find((r: { id: string }) => r.id === rows[3]!.id);
    assert.equal(unknown.api_estimate?.amount, null);
    assert.equal(unknown.api_estimate?.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(body), /private-other/);
    assert.doesNotMatch(JSON.stringify(targets), /private-other/);
    const unavailable = await handleModelHistory(request(), {
      ...access,
      currentPrices: async () => {
        throw new Error("private error sentinel");
      },
    });
    assert.equal(unavailable.status, 200);
    const withoutRates = await unavailable.json();
    assert.equal(withoutRates.records[0].api_estimate?.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(withoutRates), /private error sentinel/);
    assert.equal(
      (
        await f.db.query(
          "SELECT md5(string_agg(row_to_json(r)::text,',' ORDER BY id)) AS hash FROM basalt_model_requests r",
        )
      ).rows[0]?.hash,
      before,
    );
  });
});

test("request estimates price only the cursor page, batch new targets and retain imported charges", async () => {
  await seriesFixture(async (f) => {
    const source = await digest("home-local-v1");
    const homeRows = Array.from({ length: 201 }, (_, i) => ({
      source,
      provider: "claude",
      model: `page-model-${i}`,
      tokenQuality: "complete" as const,
      inputTokens: "1500",
      outputTokens: "250",
      cacheReadTokens: "400",
      cacheWriteTokens: "100",
      totalTokens: "1750",
    }));
    await f.insert(...homeRows.slice(0, 200));
    await f.insert(homeRows[200]!, {
      model: "imported-model",
      provider: "claude",
      timestamp: "2026-01-01T00:01:00.000000000Z",
      cost: "12",
      currency: "USD",
      costBasis: "historical-api-price",
      attribution: "import-owner",
    });
    const batches: (readonly { provider: string; model: string }[])[] = [];
    const currentPrices = async (targets: readonly { provider: string; model: string }[]) => {
      const sessions = await f.db.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1",
        [f.schema],
      );
      assert.equal(sessions.rows[0]?.count, 0, "Price fetches hold no History database session");
      batches.push(targets);
      assert.ok(targets.length <= 100);
      return {
        prices: targets.flatMap((target) => [
          { ...prices[0]!, ...target, version: "normal-context" },
          { ...prices[0]!, ...target, input: "8", minInput: "1000", version: "long-context" },
        ]),
        issues: [],
      };
    };
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.set("options", `-c search_path=${f.schema}`);
    url.searchParams.set("application_name", f.schema);
    const query = { pool: (await digest(pool)).slice(0, 16), from, to };
    const first = await readPricedRequests(url.toString(), query, currentPrices);
    assert.equal(first.records.length, 200);
    assert.ok(first.next);
    const imported = first.records.find((row) => row.model === "imported-model")!;
    assert.equal(imported.api_estimate?.amount, null);
    assert.match(imported.api_estimate?.reason ?? "", /token counts are missing/);
    assert.equal(imported.cost, "12.000000000000");
    assert.equal(imported.currency, "USD");
    const home = first.records.filter((row) => row.model !== "imported-model");
    assert.ok(home.every((row) => row.api_estimate?.amount === "0.013580000000"));
    assert.ok(home.every((row) => row.api_estimate?.price?.version === "long-context"));
    assert.equal(batches.length, 2);
    assert.deepEqual(
      batches
        .flat()
        .map((target) => target.model)
        .sort(),
      first.records.map((row) => row.model).sort(),
    );
    const next = await readPricedRequests(
      url.toString(),
      { ...query, after: first.next! },
      currentPrices,
    );
    assert.equal(next.records.length, 2);
    assert.equal(next.next, null);
    assert.ok(next.records.every((row) => !first.records.some((prior) => prior.id === row.id)));
    assert.ok(next.records.every((row) => row.api_estimate?.amount === "0.013580000000"));
  });
});
