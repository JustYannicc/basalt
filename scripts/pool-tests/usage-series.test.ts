import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../../src/pool/backend-users.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { lastSuccessAt } from "../../src/pool/model-history/last-success.ts";
import {
  seriesAuthority,
  seriesInput,
  successRate,
} from "../../src/pool/model-history/series-input.ts";
import { homeAccountMappingProven } from "../../src/pool/model-history/series-mapping.ts";
import { accountAuthority, authority, full, input, seriesFixture } from "./series-fixture.ts";

test("usage series clips exact half-open UTC buckets, preserves null and zero, and never converts token sums to Number", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const empty = await poolUsageSeries(db, input, authority);
    assert.deepEqual(empty.groups, []);
    assert.equal(empty.coverage.firstAt, null);
    assert.equal(empty.asOf, null);
    assert.equal(successRate(0, 0), null);
    await insert(
      { timestamp: timestamp("2026-01-01T00:29:59.999999999Z"), inputTokens: "9000" },
      {
        timestamp: timestamp("2026-01-01T00:30:00Z"),
        inputTokens: "9007199254740993",
        outputTokens: "0",
      },
      { timestamp: timestamp("2026-01-01T00:59:59.999999999Z"), inputTokens: "1", failed: true },
      { timestamp: timestamp("2026-01-01T01:14:59.999999999Z"), inputTokens: "0" },
      { timestamp: timestamp("2026-01-01T01:15:00Z"), inputTokens: "500" },
    );
    const query = {
      ...input,
      from: "2026-01-01T01:30:00+01:00",
      to: "2026-01-01T01:15:00Z",
      by: ["model"],
    };
    const result = await poolUsageSeries(db, query, authority);
    assert.equal(result.from, query.from);
    assert.equal(result.to, query.to);
    assert.deepEqual(result.groups[0]!.key, { model: null, currency: null });
    const buckets = result.groups[0]!.buckets.map(full);
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0]!.at, timestamp("2026-01-01T00:00:00Z"));
    assert.ok(buckets.every((bucket) => bucket.partial));
    assert.deepEqual(buckets[0]!.tokens.input, { sum: "9007199254740994", known: 2, missing: 0 });
    assert.deepEqual(buckets[0]!.tokens.output, { sum: "0", known: 1, missing: 1 });
    assert.deepEqual(buckets[0]!.tokens.reasoning, { sum: null, known: 0, missing: 2 });
    assert.deepEqual(buckets[1]!.tokens.input, { sum: "0", known: 1, missing: 0 });
    assert.equal(buckets[0]!.requests, 2);
    assert.equal(buckets[0]!.successRate, 0.5);
    assert.equal(buckets[0]!.lastSuccessAtInRange, timestamp("2026-01-01T00:30:00Z"));
    const window = { from: "2026-01-01T00:40:03.123456Z", to: "2026-01-01T01:04:02.654321Z" };
    const exactWindow = await poolUsageSeries(db, { ...query, window }, authority);
    assert.deepEqual(exactWindow.window, window);
    assert.equal(exactWindow.groups[0]!.buckets.length, 1);
    assert.equal(full(exactWindow.groups[0]!.buckets[0]).lastSuccessAtInRange, null);
    assert.equal(full(exactWindow.groups[0]!.buckets[0]).successRate, 0);
    const daily = await poolUsageSeries(db, { ...query, bucket: "day" }, authority);
    assert.equal(daily.groups[0]!.buckets.length, 1);
    assert.equal(daily.groups[0]!.buckets[0]!.partial, true);
    assert.throws(() => seriesInput({ ...input, to: "2027-02-06T00:00:00Z" }));
    assert.equal(seriesInput({ ...input, to: "2027-02-05T00:00:00Z" }).bucket, "hour");
  });
});

test("currency always groups separately, costs never mix bases, and import-owner never becomes the operator person", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const person = await digest("operator");
    await insert(
      {
        cost: "1.250000000001",
        currency: "credits",
        costBasis: "home-charge",
        attribution: "import-owner",
        person,
      },
      {
        cost: "2.500000000002",
        currency: "USD",
        costBasis: "historical-api-price",
        attribution: "import-owner",
        person,
      },
      {
        cost: "3.000000000003",
        currency: "USD",
        costBasis: "home-charge",
        attribution: "import-owner",
        person,
      },
      { person, inputTokens: "0", attribution: "key-at-capture" },
      { source: await digest("pool-gateway-v1"), failed: true },
    );
    const result = await poolUsageSeries(db, { ...input, by: ["person", "source"] }, authority);
    const usd = full(result.groups.find((group) => group.key.currency === "USD")!.buckets[0]);
    assert.equal(usd.cost.homeCharge.amount, "3.000000000003");
    assert.equal(usd.cost.importedApiPrice.amount, "2.500000000002");
    assert.equal(usd.cost.apiEquivalent.status, "unavailable");
    assert.equal(usd.cost.homeCharge.priced, 1);
    assert.equal(usd.cost.importedApiPrice.priced, 1);
    const credits = result.groups.find((group) => group.key.currency === "credits")!;
    assert.equal(full(credits.buckets[0]).cost.homeCharge.amount, "1.250000000001");
    assert.equal(full(credits.buckets[0]).cost.homeCharge.currency, "credits");
    assert.equal(full(credits.buckets[0]).cost.importedApiPrice.amount, null);
    for (const group of result.groups.filter((group) => group.key.attribution === "import-owner"))
      assert.equal(group.key.person, null);
    assert.equal(result.coverage.pricing.apiEquivalent.status, "unavailable");
    assert.equal(result.coverage.pricing.missingSnapshot, 3);
    assert.equal(result.coverage.pricing.missingVersion, 3);
    assert.equal(result.coverage.percentiles.status, "unavailable");
    assert.equal(result.coverage.priceProjection.status, "unavailable");
    assert.equal(result.coverage.seasonalTrainingRange.status, "unavailable");
    assert.equal(
      result.groups
        .flatMap((group) => group.buckets)
        .reduce((sum, bucket) => sum + bucket.unassignedFailures, 0),
      1,
    );
    const homeSource = await digest("home-local-v1");
    const filtered = await poolUsageSeries(db, { ...input, sources: [homeSource] }, authority);
    assert.deepEqual(filtered.groups, []);
    assert.ok(result.coverage.sources.some((source) => source.kind === "gateway"));
    assert.ok(result.coverage.sources.some((source) => source.kind === "import"));
  });
});

test("the configured host mapping gate controls native accounts; foreign references never join them", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const native = await accountAuthority();
    const access = seriesAuthority({
      canManage: true,
      mappingProven: true,
      accounts: native.authority.accounts,
    });
    assert.equal(
      access.mappingProven,
      homeAccountMappingProven,
      "a signed assertion cannot override the configured mapping gate",
    );
    await insert(
      { source: native.source, account: native.visible },
      { account: native.visible, provider: "imported-provider" },
    );
    const result = await poolUsageSeries(db, { ...input, by: ["account", "provider"] }, access);
    assert.equal(JSON.stringify(result).includes("saved-visible"), homeAccountMappingProven);
    assert.equal(
      result.coverage.mapping.proof,
      homeAccountMappingProven ? "proven" : "unavailable",
    );
    assert.equal(result.coverage.mapping.unmapped, homeAccountMappingProven ? 1 : 2);
    assert.equal(result.coverage.pricing.missing, homeAccountMappingProven ? 0 : 1);
    const filtered = await poolUsageSeries(db, { ...input, accounts: ["saved-visible"] }, access);
    assert.equal(filtered.groups.length, homeAccountMappingProven ? 1 : 0);
    assert.equal(
      filtered.coverage.mapping.unmapped,
      homeAccountMappingProven ? 0 : 2,
      "only a proven mapping can filter accounts",
    );
    const foreign = await poolUsageSeries(
      db,
      { ...input, by: ["account"], sources: [await digest("fixture-import")] },
      native.authority,
    );
    assert.equal(foreign.groups[0]!.key.account, "unmapped");
  });
});

test("management and saved-account inspection are independent; otherAccounts contains counts only", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const native = await accountAuthority();
    await insert(
      { source: native.source, account: native.visible },
      {
        source: native.source,
        account: native.hidden,
        provider: "private-provider-sentinel",
        model: "private-model-sentinel",
        person: await digest("private-person"),
        cost: "999.000000000000",
        currency: "private-unit",
        costBasis: "home-charge",
        inputTokens: "12345",
      },
    );
    const result = await poolUsageSeries(
      db,
      { ...input, by: ["account", "provider", "model", "person"] },
      native.authority,
    );
    const other = result.groups.find((group) => group.key.account === "otherAccounts")!;
    assert.deepEqual(other.key, {
      account: "otherAccounts",
      currency: null,
      provider: null,
      model: null,
      person: null,
      attribution: null,
    });
    assert.equal(other.buckets[0]!.requests, 1);
    assert.equal(Object.hasOwn(other.buckets[0]!, "tokens"), false);
    assert.equal(Object.hasOwn(other.buckets[0]!, "cost"), false);
    for (const sentinel of [
      "private-provider-sentinel",
      "private-model-sentinel",
      "private-unit",
      "999.000000000000",
      "12345",
      native.hidden,
    ])
      assert.equal(JSON.stringify(result).includes(sentinel), false);
    const selected = await poolUsageSeries(
      db,
      { ...input, accounts: ["saved-visible"], by: ["account"] },
      native.authority,
    );
    assert.equal(selected.groups.length, 1);
    assert.equal(selected.groups[0]!.key.account, "saved-visible");
    const noRead = {
      query: async () => {
        assert.fail("access refusal must precede a database query");
      },
    };
    await assert.rejects(poolUsageSeries(noRead, input, { ...native.authority, canManage: false }));
    await assert.rejects(
      poolUsageSeries(noRead, { ...input, accounts: ["private-saved-account"] }, native.authority),
    );
    await assert.rejects(
      lastSuccessAt(
        noRead,
        { pool: input.pool, accounts: ["private-saved-account"] },
        native.authority,
      ),
    );
  });
});

test("lastSuccessAt is a bounded latest-ever lookup, separate from the selected ticks and current generation coverage", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const native = await accountAuthority();
    await insert(
      {
        source: native.source,
        account: native.visible,
        timestamp: timestamp("2025-01-01T00:00:00Z"),
      },
      { source: native.source, account: native.visible, failed: true },
      {
        source: native.source,
        account: native.hidden,
        timestamp: timestamp("2027-01-01T00:00:00Z"),
      },
    );
    const series = await poolUsageSeries(
      db,
      { ...input, accounts: ["saved-visible"] },
      native.authority,
    );
    assert.equal(full(series.groups[0]!.buckets[0]).lastSuccessAtInRange, null);
    const latest = await lastSuccessAt(
      db,
      { pool: input.pool, accounts: ["saved-visible"] },
      native.authority,
    );
    assert.equal(latest.accounts[0]!.lastSuccessAt, timestamp("2025-01-01T00:00:00Z"));
    assert.equal(latest.mapping.historicalGenerations, "unknown");
    assert.equal(latest.mapping.current, true);
    assert.throws(() => seriesAuthority({ canManage: false, accounts: [] }));
    assert.throws(() => seriesInput({ ...input, accounts: Array(501).fill("saved-visible") }));
  });
});

test("history public USD uses request-level rates while preserving native scope, unknown models and retained charges", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const native = await accountAuthority();
    const model = "claude-opus-5-5";
    const row = {
      source: native.source,
      account: native.visible,
      provider: "claude",
      model,
      apiType: "messages",
      inputTokens: "1000000",
      outputTokens: "200000",
      cacheReadTokens: "400000",
      cacheWriteTokens: "100000",
      reasoningTokens: "50000",
      totalTokens: "1200000",
      tokenQuality: "complete" as const,
      cost: "99.000000000000",
      currency: "credits",
      costBasis: "home-charge" as const,
    };
    await insert(
      row,
      { ...row, account: native.hidden, model: "private-model-sentinel" },
      { ...row, model: "unpublished-model-9988" },
      { ...row, timestamp: timestamp("2027-01-01T00:00:00Z") },
      { ...row, source: await digest("fixture-import"), attribution: "import-owner" },
    );
    const { baselinePrices } = await import("../../src/pool/public-price-baseline.ts");
    const seen: unknown[] = [];
    const result = await poolUsageSeries(
      db,
      {
        ...input,
        by: ["provider", "model", "source"],
        sources: [native.source],
        accounts: ["saved-visible"],
      },
      native.authority,
      "owned",
      async (targets) => {
        seen.push(targets);
        return {
          prices: baselinePrices({ provider: "claude", model }).prices.map((p) => ({
            ...p,
            refreshFailed: true,
          })),
          issues: [
            {
              provider: "claude",
              model: "unpublished-model-9988",
              reason: "No public price for unpublished-model-9988",
            },
          ],
        };
      },
    );
    assert.deepEqual(seen, [
      [
        { provider: "claude", model },
        { provider: "claude", model: "unpublished-model-9988" },
      ],
    ]);
    assert.equal(JSON.stringify(result).includes("private-model-sentinel"), false);
    const priced = full(result.groups.find((g) => g.key.model === model)!.buckets[0]);
    // 500k uncached input * 4 + 200k output * 20 + 400k cache reads * .2 + 100k writes * 5, per million.
    assert.equal(priced.cost.apiEstimate!.amount, "6.580000000000");
    assert.equal(priced.cost.apiEstimate!.pricedRequests, 1);
    assert.equal(priced.cost.apiEstimate!.price!.basis, "baseline");
    assert.equal(priced.cost.apiEstimate!.price!.refreshFailed, true);
    assert.equal(priced.cost.homeCharge.amount, "99.000000000000");
    assert.equal(priced.cost.homeCharge.currency, "credits");
    const unknown = full(
      result.groups.find((g) => g.key.model === "unpublished-model-9988")!.buckets[0],
    );
    assert.equal(unknown.cost.apiEstimate!.amount, null);
    assert.equal(unknown.cost.apiEstimate!.excluded.unpriced, 1);
    assert.match(unknown.cost.apiEstimate!.reason!, /No public price for unpublished-model-9988/);
  });
});
