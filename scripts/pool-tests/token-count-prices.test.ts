import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolOverviewAuthority } from "../../apps/pool/overview-contract.ts";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { activateHomeBackfill, planHomeBackfill } from "../../src/pool/model-history/activation.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { officialCosts, officialCostMetric } from "../../src/pool/model-history/official-cost.ts";
import { poolUsageOverview, poolPersonalOverview } from "../../src/pool/model-history/overview.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { reference } from "../../src/pool/model-history/record.ts";
import { homeMetadataFixture } from "./history-fixture.ts";
import { full, pool, seriesFixture } from "./series-fixture.ts";

const from = "2026-11-02T00:00:00Z",
  to = "2026-11-13T00:00:00Z";
const prices = [
  {
    provider: "claude",
    model: "claude-opus-5-5",
    currency: "USD" as const,
    input: "4",
    output: "20",
    cacheRead: "0.2",
    cacheWrite: "5",
    request: "0",
    tier: "*",
    minInput: "0",
    source: "models.dev" as const,
    version: "fixture-v1",
    asOf: "2026-11-12T00:00:00Z",
  },
];

test("1,112 continuous Home legacy rows with no API type retain charges and gain labelled USD in overview and History", async () => {
  await seriesFixture(async (f) => {
    await homeMetadataFixture(f.db);
    await f.db.query('INSERT INTO "user" VALUES (1,$1)', [await backendUserName("member", pool)]);
    const fingerprint = `sha256:${"a".repeat(64)}`;
    await f.db.query("INSERT INTO api_key VALUES (1,$1,1,NULL)", [fingerprint]);
    // Match the production aggregate, with synthetic independent token buckets and no content.
    await f.db.query(
      `INSERT INTO usage (id,timestamp,auth_index,provider,model,endpoint,api_key,
      token_accounting_version,token_accounting_quality,service_tier,input_tokens,output_tokens,
      cache_read_tokens,cache_creation_tokens,reasoning_tokens,total_tokens,failed)
      SELECT n,'2026-11-02T15:36:52Z'::timestamptz+(n-1)*interval '13 minutes',
        'fixture-account','claude','claude-opus-5-5',NULL,$1,0,'','auto',
        CASE WHEN n BETWEEN 1031 AND 1044 THEN 0 WHEN n BETWEEN 1045 AND 1085 THEN 100 ELSE 1000 END,
        CASE WHEN n BETWEEN 1031 AND 1085 THEN 0 ELSE 200 END,
        CASE WHEN n BETWEEN 1031 AND 1044 THEN 0 WHEN n BETWEEN 1045 AND 1085 THEN 20 ELSE 400 END,
        CASE WHEN n BETWEEN 1031 AND 1044 THEN 0 WHEN n BETWEEN 1045 AND 1085 THEN 5 ELSE 100 END,
        CASE WHEN n BETWEEN 1031 AND 1085 THEN 0 ELSE 50 END,
        CASE WHEN n BETWEEN 1031 AND 1044 THEN 0 WHEN n BETWEEN 1045 AND 1085 THEN 125 ELSE 1750 END,
        n BETWEEN 1031 AND 1104 FROM generate_series(1,1112) n`,
      [fingerprint],
    );
    const snapshot = {
      input_price_per_million: 4,
      output_price_per_million: 20,
      cache_read_price_per_million: 0.2,
      cache_write_price_per_million: 5,
      request_price: 0,
      matched_service_tier: "*",
      min_input_tokens: 0,
      provider: "claude",
      model: "claude-opus-5-5",
    };
    await f.db.query(
      `INSERT INTO billing_charge (id,usage_id,amount,matched_price_rule,price_snapshot,api_key_id,user_id)
      SELECT 'fixture-charge-'||n,n,7,'fixture-price',$1::jsonb,1,1 FROM generate_series(1,1030) n`,
      [JSON.stringify(snapshot)],
    );
    await activateHomeBackfill(f.db, await planHomeBackfill(f.db));
    for (let pass = 0; pass < 3; pass++) await captureHomeRequests(f.db);
    const saved = (
      await f.db.query(`SELECT count(*)::int AS rows,
      count(*) FILTER (WHERE token_quality='legacy' AND api_type IS NULL AND endpoint IS NULL)::int AS legacy,
      count(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL OR cache_read_tokens IS NULL
        OR cache_write_tokens IS NULL OR reasoning_tokens IS NULL OR total_tokens IS NULL)::int AS missing,
      count(*) FILTER (WHERE cost_basis='home-charge')::int AS charged,
      count(*) FILTER (WHERE cost_basis='unpriced')::int AS uncharged,
      count(*) FILTER (WHERE failed)::int AS failed FROM basalt_model_requests`)
    ).rows[0];
    assert.deepEqual(saved, {
      rows: 1112,
      legacy: 1112,
      missing: 0,
      charged: 1030,
      uncharged: 82,
      failed: 74,
    });
    const metric = officialCostMetric(
      await officialCosts(f.db, { pool, from, to }, prices),
      prices,
    );
    assert.equal(metric.pricedRequests, 1112);
    assert.equal(metric.amount, "10.143649000000");
    assert.equal(metric.price?.calculation, "token-counts");
    assert.equal(metric.excluded.unpriced, 0);
    const source = await digest("home-local-v1"),
      person = await digest("member");
    const account = (await reference(source, "account", "fixture-account"))!;
    const authority = {
      canManage: true,
      mappingProven: true,
      accounts: [{ account: "saved", history: [account], offering: "subscription" as const }],
    } satisfies PoolOverviewAuthority;
    const history = await poolUsageSeries(
      f.db,
      { pool, from, to, bucket: "day", by: ["model"] },
      authority,
      "owned",
      { prices, issues: [] },
    );
    const buckets = history.groups.flatMap((g) => g.buckets.map(full));
    assert.equal(
      buckets.reduce((n, b) => n + (b.cost.apiEstimate?.pricedRequests ?? 0), 0),
      1112,
    );
    assert.equal(
      buckets.reduce((n, b) => n + BigInt(b.cost.apiEstimate!.amount!.replace(".", "")), 0n),
      10143649000000n,
    );
    assert.ok(buckets.every((b) => b.cost.apiEstimate?.price?.calculation === "token-counts"));
    assert.equal(
      buckets.reduce((n, b) => n + Number(b.cost.homeCharge.amount ?? 0), 0),
      7210,
    );
    const overview = await poolUsageOverview(f.db, {
      pool,
      from,
      to,
      days: 30,
      authority,
      directory: {
        members: [{ person, displayName: "Fixture member", active: true }],
        activeCount: 1,
        totalCount: 1,
      },
      prices,
    });
    assert.equal(overview.metrics.apiBilled.amount, metric.amount);
    assert.equal(overview.metrics.subscriptionValue.amount, metric.amount);
    assert.equal(overview.metrics.apiBilled.price?.calculation, "token-counts");
    assert.equal(overview.metrics.subscriptionValue.price?.calculation, "token-counts");
    assert.equal(overview.metrics.usageSlices[0]?.apiBilled, metric.amount);
    assert.equal(overview.metrics.usageSlices[0]?.price?.calculation, "token-counts");

    // An estimate outside subscription usage must not relabel canonical subscription value.
    await f.db.query(
      `INSERT INTO usage (id,timestamp,auth_index,provider,model,endpoint,api_key,
      token_accounting_version,token_accounting_quality,accounting_input_tokens,accounting_output_tokens,
      accounting_cache_read_tokens,accounting_cache_write_tokens,accounting_total_tokens)
      VALUES (1113,'2026-11-12T18:00:00Z','canonical-account','claude','claude-opus-5-5','/v1/messages',
        $1,2,'complete',1000,200,400,100,1200)`,
      [fingerprint],
    );
    await captureHomeRequests(f.db);
    const canonicalAccount = (await reference(source, "account", "canonical-account"))!;
    const mixed = {
      ...authority,
      accounts: [
        { account: "saved", history: [account], offering: "metered_api" as const },
        { account: "canonical", history: [canonicalAccount], offering: "subscription" as const },
      ],
    };
    const mixedOverview = await poolUsageOverview(f.db, {
      pool,
      from,
      to,
      days: 30,
      authority: mixed,
      directory: {
        members: [{ person, displayName: "Fixture member", active: true }],
        activeCount: 1,
        totalCount: 1,
      },
      prices,
    });
    const personal = await poolPersonalOverview(
      f.db,
      {
        pool,
        person,
        from,
        to,
        days: 30,
        offerings: mixed.accounts.flatMap((a) =>
          a.history.map((history) => ({ history, offering: a.offering })),
        ),
      },
      prices,
    );
    for (const result of [mixedOverview, personal]) {
      assert.equal(result.metrics.apiBilled.price?.calculation, "token-counts");
      assert.equal(result.metrics.subscriptionValue.amount, "0.006580000000");
      assert.equal(result.metrics.subscriptionValue.price?.calculation, undefined);
    }
  });
});

test("fresh Home captures decode bigint V2 versions and retain safe API type and normalized counters", async () => {
  await seriesFixture(async (f) => {
    await homeMetadataFixture(f.db);
    await f.db.query(`INSERT INTO usage (timestamp,provider,model,endpoint,token_accounting_version,
      token_accounting_quality,accounting_input_tokens,accounting_output_tokens,accounting_cache_read_tokens,
      accounting_cache_write_tokens,accounting_total_tokens) VALUES ('2026-11-12T12:00:00Z','claude',
      'claude-opus-5-5','/v1/messages',2,'complete',1500000,250000,400000,100000,1750000)`);
    assert.equal(
      (await f.db.query("SELECT token_accounting_version FROM usage")).rows[0]
        ?.token_accounting_version,
      "2",
    );
    await activateHomeBackfill(f.db, await planHomeBackfill(f.db));
    await captureHomeRequests(f.db);
    const saved = (
      await f.db.query(
        "SELECT endpoint,api_type,token_quality,input_tokens::text,output_tokens::text FROM basalt_model_requests",
      )
    ).rows[0];
    assert.deepEqual(saved, {
      endpoint: "/v1/messages",
      api_type: "messages",
      token_quality: "complete",
      input_tokens: "1500000",
      output_tokens: "250000",
    });
  });
});

test("counter estimates preserve cache and reasoning once, use context bands, and leave missing counters unpriced", async () => {
  await seriesFixture(async (f) => {
    const source = await digest("home-local-v1"),
      poolId = (await digest(pool)).slice(0, 16);
    const base = {
      source,
      pool: poolId,
      provider: "claude",
      model: "claude-opus-5-5",
      apiType: null,
      inputTokens: "1000000",
      outputTokens: "200000",
      cacheReadTokens: "400000",
      cacheWriteTokens: "100000",
      reasoningTokens: "50000",
      totalTokens: "1750000",
      tokenQuality: "legacy" as const,
    };
    const checks = [
      { row: base, expected: "9.580000000000" },
      {
        // Compaction counters stay inclusive when their API metadata is lost.
        row: { ...base, inputTokens: "1500000", outputTokens: "250000", totalTokens: "1750000" },
        expected: "9.580000000000",
      },
      {
        row: { ...base, inputTokens: "1500000", totalTokens: "1750000" },
        expected: "9.580000000000",
      },
      {
        // Without a total, cache buckets larger than input identify separate counters.
        row: {
          ...base,
          inputTokens: "100000",
          outputTokens: "200000",
          reasoningTokens: "50000",
          totalTokens: null,
        },
        expected: "4.980000000000",
      },
      {
        row: {
          ...base,
          inputTokens: "1000000",
          outputTokens: "0",
          cacheReadTokens: "0",
          cacheWriteTokens: "0",
          reasoningTokens: "0",
          totalTokens: "1000000",
        },
        expected: "4.000000000000",
      },
    ];
    for (const [index, c] of checks.entries()) {
      const day = index + 2;
      await f.insert({
        ...c.row,
        timestamp: `2026-11-${String(day).padStart(2, "0")}T12:00:00.000000000Z`,
      });
      const result = officialCostMetric(
        await officialCosts(
          f.db,
          {
            pool,
            from: `2026-11-${String(day).padStart(2, "0")}T00:00:00Z`,
            to: `2026-11-${String(day + 1).padStart(2, "0")}T00:00:00Z`,
          },
          prices,
        ),
        prices,
      );
      assert.equal(result.amount, c.expected);
      assert.equal(result.price?.calculation, "token-counts");
    }
    await f.insert({ ...base, timestamp: "2026-11-08T12:00:00.000000000Z", cacheReadTokens: null });
    const missing = officialCostMetric(
      await officialCosts(
        f.db,
        { pool, from: "2026-11-08T00:00:00Z", to: "2026-11-09T00:00:00Z" },
        prices,
      ),
      prices,
    );
    assert.equal(missing.amount, null);
    assert.match(missing.reason!, /token counts are missing/);
    const banded = [{ ...prices[0]!, minInput: "1400000", input: "8", output: "40" }, prices[0]!];
    const premium = officialCostMetric(
      await officialCosts(
        f.db,
        { pool, from: "2026-11-02T00:00:00Z", to: "2026-11-03T00:00:00Z" },
        banded,
      ),
      banded,
    );
    assert.equal(premium.amount, "18.580000000000");
  });
});
