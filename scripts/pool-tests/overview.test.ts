import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import type {
  OverviewApiPrice,
  PoolOverviewSignedInput,
} from "../../apps/pool/overview-contract.ts";
import {
  overviewTargets,
  poolPersonalOverview,
  poolUsageOverview,
} from "../../src/pool/model-history/overview.ts";
import { reference, timestamp, type ModelRequest } from "../../src/pool/model-history/record.ts";
import { homeAccountMappingProven } from "../../src/pool/model-history/series-mapping.ts";
import { pool, seriesFixture } from "./series-fixture.ts";
import { pricedSummary } from "../../src/pool/model-history/priced-summary.ts";
import { homeRequest } from "../../src/pool/model-history/home.ts";
import { poolGroupPrefix } from "../../src/pool/control.ts";
import { OverviewPrices } from "../../src/pool/overview-prices.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { UsageLedger } from "../../src/pool/usage-summary.ts";
import type { UsageStorage } from "../../src/pool/usage-storage.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];

const homeSourceName = "home-local-v1";
const gatewaySourceName = "pool-gateway-v1";
const from = "2026-01-01T00:00:00Z";
const to = "2026-01-04T00:00:00Z";
const priceDate = "2026-11-04T00:00:00.000Z";

const rates = (minInput: string, input: string): OverviewApiPrice => ({
  provider: "provider-alias",
  model: "model-fixture",
  currency: "USD",
  input,
  output: "30",
  cacheRead: "2",
  cacheWrite: "4",
  request: "0",
  tier: "*",
  minInput,
  asOf: priceDate,
  source: "models.dev",
  version: "fixture-v1",
});

async function prepareHomeSource(client: pg.Client, username: string) {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  await client.query(`CREATE TABLE "user" (id bigint PRIMARY KEY, username text NOT NULL)`);
  await client.query(
    `CREATE TABLE api_key (id bigint PRIMARY KEY, diagnostic_fingerprint text NOT NULL, user_id bigint)`,
  );
  await client.query(
    `CREATE TABLE billing_charge (id bigserial PRIMARY KEY, usage_id bigint, user_id bigint, api_key_id bigint)`,
  );
  await client.query(
    `CREATE TABLE usage (id bigint PRIMARY KEY, timestamp timestamptz NOT NULL, api_key text)`,
  );
  await client.query(`INSERT INTO "user" (id,username) VALUES (7,$1)`, [username]);
  await client.query(`INSERT INTO api_key (id,diagnostic_fingerprint,user_id) VALUES (9,$1,7)`, [
    fingerprint,
  ]);
  return fingerprint;
}

async function addHomeRequest(
  fixture: Fixture,
  fingerprint: string,
  id: number,
  account: string,
  at: string,
  overrides: Partial<ModelRequest> = {},
) {
  const source = await digest(homeSourceName);
  const sourceRecord = await digest(JSON.stringify(["usage", String(id)]));
  const person = await digest("member");
  await fixture.insert({
    source,
    sourceRecord,
    pool: (await digest(pool)).slice(0, 16),
    person,
    account,
    timestamp: timestamp(at),
    provider: "provider-alias",
    model: "model-fixture",
    apiType: "responses",
    inputTokens: "100",
    outputTokens: "20",
    cacheReadTokens: "30",
    cacheWriteTokens: "10",
    totalTokens: "120",
    tokenQuality: "complete",
    ...overrides,
  });
  await fixture.client.query(`INSERT INTO usage (id,timestamp,api_key) VALUES ($1,$2,$3)`, [
    id,
    at,
    fingerprint,
  ]);
}

async function input(
  authority: PoolOverviewSignedInput["authority"],
): Promise<PoolOverviewSignedInput> {
  const person = await digest("member");
  return {
    pool,
    from,
    to,
    days: 7,
    authority,
    directory: {
      members: [
        { person, displayName: "Pat Example", active: true },
        { person: await digest("idle-member"), displayName: "Idle Example", active: true },
      ],
      activeCount: 2,
      totalCount: 2,
    },
  };
}

test("an SLO SQL error cannot discard the overview's request, cost and token answers", async () => {
  await seriesFixture(async (fixture) => {
    const fingerprint = await prepareHomeSource(
      fixture.client,
      await backendUserName("member", pool),
    );
    const source = await digest(homeSourceName);
    const account = (await reference(source, "account", "api-fixture"))!;
    await addHomeRequest(fixture, fingerprint, 1, account, from);
    const signed = {
      ...(await input({
        canManage: true,
        mappingProven: homeAccountMappingProven,
        accounts: [{ account: "saved-api", history: [account], offering: "metered_api" }],
      })),
      prices: [rates("0", "10")],
    };
    const before = await poolUsageOverview(fixture.db, signed);
    const fault = {
      query: (text: string, values?: unknown[]) =>
        text.includes("SELECT backfill_complete")
          ? fixture.db.query("SELECT missing_slo_fixture_column")
          : fixture.db.query(text, values),
    };
    const result = await poolUsageOverview(fault, signed);
    assert.deepEqual(result.reliability, { unavailable: true });
    assert.deepEqual(result.metrics.apiBilled, before.metrics.apiBilled);
    assert.deepEqual(result.people.groups, before.people.groups);
    assert.deepEqual((await fixture.db.query("SELECT 1 AS ready")).rows, [{ ready: 1 }]);
  });
});

test("overview prices protocol aliases from total context, keeps excluded counts distinct, and includes unassigned failures", async () => {
  await seriesFixture(async (fixture) => {
    const fingerprint = await prepareHomeSource(
      fixture.client,
      await backendUserName("member", pool),
    );
    const homeSource = await digest(homeSourceName);
    const subscriptionRef = (await reference(homeSource, "account", "subscription-auth"))!;
    const apiRef = (await reference(homeSource, "account", "api-auth"))!;
    const signed = await input({
      canManage: true,
      mappingProven: homeAccountMappingProven,
      accounts: [
        { account: "saved-subscription", history: [subscriptionRef], offering: "subscription" },
        { account: "saved-api", history: [apiRef], offering: "metered_api" },
      ],
    });
    await addHomeRequest(fixture, fingerprint, 1, subscriptionRef, from);
    await addHomeRequest(fixture, fingerprint, 2, subscriptionRef, "2026-01-02T01:15:00Z", {
      apiType: "messages",
      inputTokens: "60",
      totalTokens: "120",
      tokenQuality: "legacy",
    });
    await addHomeRequest(fixture, fingerprint, 3, "saved-api", "2026-01-02T01:30:00Z", {
      source: homeSource,
      sourceRecord: await digest(JSON.stringify(["usage", "3"])),
      account: apiRef,
    });
    await addHomeRequest(fixture, fingerprint, 4, subscriptionRef, "2026-01-03T02:15:00Z");
    await addHomeRequest(fixture, fingerprint, 5, subscriptionRef, "2026-01-03T02:30:00Z", {
      apiType: "unknown-protocol",
      totalTokens: "5",
      inputTokens: "4",
      outputTokens: "1",
      tokenQuality: "legacy",
    });
    await addHomeRequest(fixture, fingerprint, 6, subscriptionRef, to);
    await fixture.client.query(`INSERT INTO usage (id,timestamp,api_key) VALUES (7,$1,$2)`, [
      "2026-01-02T03:15:00Z",
      fingerprint,
    ]);
    const gateway = await digest(gatewaySourceName);
    await fixture.insert({
      source: gateway,
      sourceRecord: await digest("gateway-failure"),
      pool: (await digest(pool)).slice(0, 16),
      timestamp: timestamp("2026-01-01T00:30:00Z"),
      provider: null,
      model: null,
      account: null,
      person: null,
      failed: true,
      tokenQuality: "unclassified",
      totalTokens: null,
      apiType: "pool-protection-unavailable",
    });
    const result = await poolUsageOverview(fixture.db, {
      ...signed,
      prices: [rates("0", "10"), rates("100", "20")],
    });

    assert.equal(result.metrics.apiBilled.status, "available");
    assert.equal(result.metrics.apiBilled.amount, "0.007600000000");
    assert.equal(result.metrics.subscriptionValue.status, "available");
    assert.equal(result.metrics.subscriptionValue.amount, "0.005700000000");
    assert.equal(result.metrics.subscriptionValue.excluded.unpriced, 1);
    assert.equal(result.metrics.apiBilled.excluded.unknownKind, 0);
    assert.equal(result.directory.activeCount, 1);
    assert.equal(result.directory.totalCount, 2);
    assert.equal(
      result.directory.members.find((member) => member.displayName === "Idle Example")?.active,
      false,
    );
    assert.equal(result.metrics.requestTokens.requests, 6);
    assert.equal(result.metrics.requestTokens.percentiles?.p50, 120);
    assert.equal(result.metrics.failureShareWorstHourP95.status, "available");
    assert.equal(result.metrics.failureShareWorstHourP95.p95, 50);
    assert.equal(result.metrics.perActivePersonPerDay.completeDays, 1);
    assert.equal(result.metrics.perActivePersonPerDay.activePeople, 1);
    assert.equal(result.homeCapture.completeHours.length, 71);
    assert.equal(result.homeCapture.completeHours.includes("2026-01-02T03:00:00.000Z"), false);
    assert.equal(result.partial, true);

    const personal = await poolPersonalOverview(
      fixture.db,
      {
        pool,
        person: await digest("member"),
        from,
        to,
        days: 7,
        offerings: signed.authority.accounts.flatMap((account) =>
          account.account === null
            ? []
            : account.history.map((history) => ({ history, offering: account.offering })),
        ),
      },
      [rates("0", "10"), rates("100", "20")],
    );
    assert.equal(personal.metrics.requestTokens.requests, 5);
    assert.equal(personal.metrics.apiBilled.status, "available");
    assert.equal(personal.metrics.apiBilled.amount, result.metrics.apiBilled.amount);
    assert.equal(personal.metrics.subscriptionValue.status, "available");
    assert.equal(
      personal.metrics.subscriptionValue.amount,
      result.metrics.subscriptionValue.amount,
    );
    assert.ok(personal.metrics.usageSlices.length > 0);
  });
});

test("personal overview scopes series, percentiles and pricing to the signed caller without a directory or pool totals", async () => {
  await seriesFixture(async (fixture) => {
    const [caller, other] = await Promise.all([digest("member-one"), digest("member-two")]);
    const home = await digest(homeSourceName);
    const poolId = (await digest(pool)).slice(0, 16);
    await fixture.insert(
      {
        source: home,
        sourceRecord: await digest("member-one-request"),
        pool: poolId,
        person: caller,
        account: await digest("member-one-account"),
        timestamp: timestamp("2026-01-01T01:00:00Z"),
        provider: "provider-one",
        model: "model-one",
        inputTokens: "7",
        outputTokens: "3",
        totalTokens: "10",
        tokenQuality: "complete",
        attribution: "key-at-capture",
      },
      {
        source: home,
        sourceRecord: await digest("member-two-request"),
        pool: poolId,
        person: other,
        account: await digest("member-two-account"),
        timestamp: timestamp("2026-01-01T02:00:00Z"),
        provider: "provider-two",
        model: "model-secret",
        inputTokens: "700",
        outputTokens: "300",
        totalTokens: "1000",
        tokenQuality: "complete",
        attribution: "key-at-capture",
      },
    );
    const result = await poolPersonalOverview(
      fixture.db,
      {
        pool,
        person: caller,
        from,
        to: "2026-01-02T00:00:00Z",
        days: 7,
        offerings: [],
      },
      [],
      "Current API price data is unavailable.",
    );
    const encoded = JSON.stringify(result);
    assert.equal(result.metrics.requestTokens.requests, 1);
    assert.deepEqual(result.metrics.requestTokens.percentiles, { p50: 10, p90: 10, p99: 10 });
    assert.deepEqual(
      new Set(result.series.groups.map((group) => group.key.person)),
      new Set([caller]),
    );
    assert.equal(result.series.coverage.capturedThrough, null);
    assert.equal(result.metrics.apiBilled.status, "unavailable");
    assert.equal(result.metrics.subscriptionValue.status, "unavailable");
    assert.equal(result.metrics.usageSlices.length, 1);
    assert.equal(result.metrics.usageSlices[0]?.person, caller);
    assert.equal(result.metrics.usageSlices[0]?.apiBilled, null);
    assert.equal(encoded.includes(other), false);
    assert.equal(encoded.includes("model-secret"), false);
    assert.equal("directory" in result, false);
    assert.equal("totalCount" in result, false);
    assert.equal("activeCount" in result, false);

    const idle = await digest("member-never-used");
    const empty = await poolPersonalOverview(
      fixture.db,
      {
        pool,
        person: idle,
        from,
        to: "2026-01-02T00:00:00Z",
        days: 7,
        offerings: [],
      },
      [],
      "Current API price data is unavailable.",
    );
    assert.equal(empty.person, idle);
    assert.equal(empty.metrics.requestTokens.requests, 0);
    assert.deepEqual(empty.series.groups, []);
    assert.equal("directory" in empty, false);

    const gatewayOnly = await digest("member-gateway-only");
    await fixture.insert({
      source: await digest(gatewaySourceName),
      sourceRecord: await digest("gateway-refusal"),
      pool: poolId,
      person: gatewayOnly,
      account: null,
      timestamp: timestamp("2026-01-01T03:00:00Z"),
      provider: null,
      model: null,
      failed: true,
      tokenQuality: "unclassified",
      totalTokens: null,
      attribution: "unknown",
    });
    const refusal = await poolPersonalOverview(
      fixture.db,
      {
        pool,
        person: gatewayOnly,
        from,
        to: "2026-01-02T00:00:00Z",
        days: 7,
        offerings: [],
      },
      [],
      "Current API price data is unavailable.",
    );
    assert.equal(refusal.metrics.requestTokens.requests, 1);
    assert.equal(refusal.metrics.apiBilled.status, "available");
    assert.equal(refusal.metrics.apiBilled.amount, "0.000000000000");
    assert.equal(refusal.metrics.apiBilled.excluded.unknownKind, 0);
  });
});

test("overview withholds unpriceable protocols and refuses rounded large token percentiles", async () => {
  await seriesFixture(async (fixture) => {
    const fingerprint = await prepareHomeSource(
      fixture.client,
      await backendUserName("member", pool),
    );
    const homeSource = await digest(homeSourceName);
    const subscriptionRef = (await reference(homeSource, "account", "subscription-auth"))!;
    const signed = await input({
      canManage: true,
      mappingProven: homeAccountMappingProven,
      accounts: [
        { account: "saved-subscription", history: [subscriptionRef], offering: "subscription" },
      ],
    });
    await addHomeRequest(fixture, fingerprint, 1, subscriptionRef, "2026-01-01T00:15:00Z", {
      apiType: "unknown-protocol",
      totalTokens: "9007199254740993",
      inputTokens: "9007199254740993",
      outputTokens: "0",
      tokenQuality: "legacy",
    });
    const result = await poolUsageOverview(fixture.db, { ...signed, prices: [rates("0", "10")] });
    assert.equal(result.metrics.apiBilled.status, "unavailable");
    assert.equal(result.metrics.apiBilled.amount, null);
    assert.equal(result.metrics.apiBilled.excluded.unpriced, 1);
    assert.equal(result.metrics.requestTokens.status, "unavailable");
    assert.equal(result.metrics.requestTokens.percentiles, null);
    assert.equal(
      result.metrics.requestTokens.reason,
      "Request token percentile exceeds the exact JSON number range.",
    );
  });
});

test("source-ID coverage proof withholds a Home hour that has not reached model history", async () => {
  await seriesFixture(async (fixture) => {
    const fingerprint = await prepareHomeSource(
      fixture.client,
      await backendUserName("member", pool),
    );
    const homeSource = await digest(homeSourceName);
    const account = (await reference(homeSource, "account", "subscription-auth"))!;
    const signed = await input({
      canManage: true,
      mappingProven: homeAccountMappingProven,
      accounts: [{ account: "saved-subscription", history: [account], offering: "subscription" }],
    });
    await addHomeRequest(fixture, fingerprint, 1, account, "2026-01-01T00:15:00Z");
    await fixture.client.query(`INSERT INTO usage (id,timestamp,api_key) VALUES (2,$1,$2)`, [
      "2026-01-02T03:15:00Z",
      fingerprint,
    ]);
    const result = await poolUsageOverview(fixture.db, { ...signed, prices: [rates("0", "10")] });
    assert.equal(result.homeCapture.completeHours.length, 71);
    assert.equal(result.homeCapture.completeHours.includes("2026-01-02T03:00:00.000Z"), false);
    assert.equal(result.partial, true);
  });
});

test("overview with no pool accounts reports the account prerequisite instead of blaming USD prices", async () => {
  await seriesFixture(async (fixture) => {
    await prepareHomeSource(fixture.client, await backendUserName("member", pool));
    const signed = await input({ canManage: true, mappingProven: true, accounts: [] });
    const result = await poolUsageOverview(fixture.db, { ...signed, prices: [] });
    assert.equal(result.metrics.apiBilled.status, "unavailable");
    assert.equal(result.metrics.apiBilled.reason, "No accounts in this pool yet.");
  });
});

test("overview retains the token-priced cost Settings can read after every account is disconnected", async () => {
  await seriesFixture(async (fixture) => {
    const username = await backendUserName("member", pool);
    const fingerprint = await prepareHomeSource(fixture.client, username);
    const values = new Map<string, unknown>();
    const storage: UsageStorage = {
      async get<T>(key: string) {
        return structuredClone(values.get(key)) as T | undefined;
      },
      async put(key, value) {
        values.set(key, structuredClone(value));
      },
      async delete(key) {
        values.delete(key);
      },
    };
    const at = "2026-01-03T01:00:00Z";
    const record = {
      id: "1",
      timestamp: at,
      provider: "provider-alias",
      model: "model-fixture",
      client: { username },
      credential: { credential_id: null },
      tokens: { input_tokens: 200000, output_tokens: 51600, total_tokens: 251600 },
      token_breakdown: {
        quality: "complete",
        total_tokens: 251600,
        input: { uncached_tokens: 200000, cache_read_tokens: 0, cache_write_tokens: 0 },
        output: { total_tokens: 51600 },
      },
      billing: { amount: 999, matched_price_rule: "fixture-credit-rule" },
    };
    const ledger = new UsageLedger(storage, {
      async allMembership() {
        return { groups: [{ id: 1, channel_name: `${poolGroupPrefix}${pool}` }], members: [] };
      },
      async data(path) {
        if (path === "/capabilities") return { capabilities: { usage_token_breakdown_v2: true } };
        const query = new URL(path, "https://fixture.invalid").searchParams;
        const included =
          Date.parse(query.get("from")!) <= Date.parse(at) &&
          Date.parse(at) < Date.parse(query.get("to")!);
        return { items: included ? [record] : [], total: included ? 1 : 0 };
      },
    });
    const now = new Date(to);
    await ledger.sync(now);
    const settings = await ledger.summary(pool, {
      owner: "member",
      caller: "member",
      members: ["member"],
      days: 7,
      now,
      canManage: true,
      cap: () => null,
    });
    assert.equal(settings.total.tokens.total, 251600);
    assert.equal(settings.total.cost, 999);
    const home = await digest(homeSourceName);
    const request = await homeRequest(
      {
        source_id: "1",
        timestamp: at,
        failed: false,
        username,
        auth_index: "disconnected-account",
        provider: record.provider,
        model: record.model,
        endpoint: "/v1/responses",
        token_accounting_version: 2,
        token_accounting_quality: "complete",
        accounting_input_tokens: "200000",
        accounting_output_tokens: "51600",
        accounting_cache_read_tokens: "0",
        accounting_cache_write_tokens: "0",
        accounting_total_tokens: "251600",
        charge_id: null,
      },
      home,
    );
    await fixture.insert(request);
    await fixture.client.query("INSERT INTO usage (id,timestamp,api_key) VALUES (1,$1,$2)", [
      at,
      fingerprint,
    ]);
    const signed = await input({ canManage: true, mappingProven: true, accounts: [] });
    const result = await poolUsageOverview(fixture.db, {
      ...signed,
      prices: [{ ...rates("0", "0.5"), output: "0", cacheRead: "0", cacheWrite: "0" }],
    });
    const priced = await pricedSummary(
      fixture.db,
      { pool, caller: "member", canManage: true, summary: settings },
      async () => [{ ...rates("0", "0.5"), output: "0", cacheRead: "0", cacheWrite: "0" }],
    );
    assert.equal(priced.total.cost, 0.1);
    assert.equal(Number(result.metrics.apiBilled.amount), priced.total.cost);
    assert.equal(priced.members?.find((member) => member.member === "member")?.cost, 0.1);
    assert.equal(priced.models[0]?.cost, 0.1);
    assert.equal(priced.days[0]?.cost, 0.1);
    assert.equal(result.metrics.apiBilled.pricedRequests, 1);
    assert.deepEqual((await overviewTargets(fixture.db, signed)).targets, [
      { provider: "provider-alias", model: "model-fixture" },
    ]);
  });
});

test("unknown official prices are unpriced in Settings and overview, never Home credits or a free request", async () => {
  await seriesFixture(async (fixture) => {
    await prepareHomeSource(fixture.client, await backendUserName("member", pool));
    await fixture.insert({
      source: await digest(homeSourceName),
      pool: (await digest(pool)).slice(0, 16),
      person: await digest("member"),
      provider: "unknown-provider",
      model: "unknown-model",
      apiType: "responses",
      inputTokens: "100",
      outputTokens: "20",
      cacheReadTokens: "0",
      cacheWriteTokens: "0",
      totalTokens: "120",
      tokenQuality: "complete",
      cost: "999",
      currency: "credits",
      costBasis: "home-charge",
    });
    const signed = await input({ canManage: true, mappingProven: true, accounts: [] });
    const overview = await poolUsageOverview(fixture.db, { ...signed, prices: [] });
    assert.equal(overview.metrics.apiBilled.status, "unavailable");
    assert.equal(overview.metrics.apiBilled.amount, null);
    assert.equal(overview.metrics.apiBilled.excluded.unpriced, 1);
    assert.match(overview.metrics.apiBilled.reason!, /No public price for unknown-model/);
    const tokens = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 };
    const summary = {
      scope: "pool" as const,
      from,
      to,
      total: { requests: 1, tokens, cost: 999, unpriced: 0 },
      models: [
        {
          provider: "unknown-provider",
          model: "unknown-model",
          requests: 1,
          tokens,
          cost: 999,
          unpriced: 0,
        },
      ],
      days: [],
      accounts: [],
      cap: null,
      readAt: null,
    };
    const settings = await pricedSummary(
      fixture.db,
      { pool, caller: "member", canManage: true, summary },
      async () => [],
    );
    assert.equal(settings.total.unpriced, 1);
    assert.equal(settings.models[0]?.unpriced, 1);
    assert.equal(settings.total.cost, 0); // Additive subtotal only; the USD formatter must show Unpriced.
  });
});

test("official USD totals keep unknown models separate and personal Settings cannot include another person's cost", async () => {
  await seriesFixture(async (fixture) => {
    await prepareHomeSource(fixture.client, await backendUserName("member", pool));
    const home = await digest(homeSourceName),
      person = await digest("member"),
      other = await digest("other");
    const base = {
      source: home,
      pool: (await digest(pool)).slice(0, 16),
      person,
      provider: "provider-alias",
      model: "model-fixture",
      apiType: "responses",
      inputTokens: "200000",
      outputTokens: "0",
      cacheReadTokens: "0",
      cacheWriteTokens: "0",
      totalTokens: "200000",
      tokenQuality: "complete" as const,
    };
    await fixture.insert(
      base,
      { ...base, model: "no-official-price" },
      { ...base, person: other, inputTokens: "900000", totalTokens: "900000" },
      { ...base, pool: (await digest("other-pool")).slice(0, 16) },
    );
    const signed = await input({ canManage: true, mappingProven: true, accounts: [] });
    const prices = [{ ...rates("0", "0.5"), output: "0", cacheRead: "0", cacheWrite: "0" }];
    const overview = await poolUsageOverview(fixture.db, { ...signed, prices });
    assert.equal(overview.metrics.apiBilled.amount, "0.550000000000");
    assert.equal(overview.metrics.apiBilled.pricedRequests, 2);
    assert.equal(overview.metrics.apiBilled.excluded.unpriced, 1);
    const personal = await poolPersonalOverview(
      fixture.db,
      { pool, person, from, to, days: 7, offerings: [] },
      prices,
    );
    assert.equal(personal.metrics.apiBilled.amount, "0.100000000000");
    assert.equal(personal.metrics.apiBilled.excluded.unpriced, 1);
    const tokens = { input: 400000, output: 0, cacheRead: 0, cacheWrite: 0, total: 400000 };
    const summary = {
      scope: "you" as const,
      from,
      to,
      total: { requests: 2, tokens, cost: 999, unpriced: 0 },
      models: [],
      days: [],
      accounts: [],
      cap: null,
      readAt: null,
    };
    const settings = await pricedSummary(
      fixture.db,
      { pool, caller: "member", canManage: false, summary },
      async () => prices,
    );
    assert.equal(settings.total.cost, Number(personal.metrics.apiBilled.amount));
    assert.equal(settings.total.unpriced, 1);
  });
});

test("public Claude prices reach both value columns and match a hand calculation with reasoning counted once", async () => {
  await seriesFixture(async (fixture) => {
    const fingerprint = await prepareHomeSource(
      fixture.client,
      await backendUserName("member", pool),
    );
    const source = await digest(homeSourceName);
    const subscription = (await reference(source, "account", "price-fixture"))!;
    await addHomeRequest(fixture, fingerprint, 1, subscription, from, {
      provider: "claude",
      model: "claude-opus-5-5",
      inputTokens: "1000000",
      outputTokens: "200000",
      cacheReadTokens: "400000",
      cacheWriteTokens: "100000",
      reasoningTokens: "50000",
      totalTokens: "1200000",
      tokenQuality: "complete",
    });
    const values = new Map<string, unknown>();
    const storage = {
      async get<T>(key: string) {
        return structuredClone(values.get(key)) as T | undefined;
      },
      async put(key: string, value: unknown) {
        values.set(key, structuredClone(value));
      },
    };
    const start = Date.parse("2026-11-12T08:00:00Z");
    let completed = start;
    const prices = new OverviewPrices(
      new HomeClient(async () => {
        completed += 500;
        return Response.json({
          source: "models.dev",
          atomic: true,
          source_version: "public-fixture",
          source_fetched_at: new Date(completed).toISOString(),
          rows: [
            {
              provider: "claude",
              model: "claude-opus-5-5",
              service_tier: "*",
              min_input_tokens: 0,
              status: "matched",
              official: { input: 4, output: 20, cache_read: 0.2, cache_write: 5, request: 0 },
            },
          ],
        });
      }),
      storage,
      () => completed,
    );
    const table = await prices.readTable([{ provider: "claude", model: "claude-opus-5-5" }]);
    const signed = await input({
      canManage: true,
      mappingProven: homeAccountMappingProven,
      accounts: [{ account: "price-fixture", history: [subscription], offering: "subscription" }],
    });
    const result = await poolUsageOverview(fixture.db, {
      ...signed,
      prices: table.prices,
      priceIssues: table.issues,
    });
    // 500k uncached * $4/M + 200k output * $20/M + 400k reads * $0.20/M + 100k writes * $5/M = $6.58.
    // The 50k reasoning tokens already belong to the 200k output tokens.
    assert.equal(result.metrics.apiBilled.amount, "6.580000000000");
    assert.equal(result.metrics.subscriptionValue.amount, "6.580000000000");
    assert.equal(result.metrics.usageSlices[0]!.apiBilled, "6.580000000000");
    assert.equal(result.metrics.usageSlices[0]!.subscriptionValue, "6.580000000000");
  });
});

test("mixed last-good catalog versions retain subscription values and the oldest source date", async () => {
  await seriesFixture(async (fixture) => {
    const fingerprint = await prepareHomeSource(
      fixture.client,
      await backendUserName("member", pool),
    );
    const source = await digest(homeSourceName),
      subscription = (await reference(source, "account", "mixed-prices"))!;
    await addHomeRequest(fixture, fingerprint, 1, subscription, from);
    const signed = await input({
      canManage: true,
      mappingProven: homeAccountMappingProven,
      accounts: [{ account: "mixed-prices", history: [subscription], offering: "subscription" }],
    });
    const result = await poolUsageOverview(fixture.db, {
      ...signed,
      prices: [
        rates("0", "10"),
        {
          ...rates("0", "20"),
          model: "other-model",
          version: "new-version",
          asOf: "2026-11-12T08:00:00.000Z",
        },
      ],
    });
    assert.equal(result.metrics.subscriptionValue.status, "available");
    assert.equal(result.metrics.subscriptionValue.price?.asOf, priceDate);
    assert.equal(result.metrics.subscriptionValue.price?.version, "fixture-v1,new-version");
  });
});

test("missing model and failed public source have specific row reasons, while good models keep their numbers", async () => {
  await seriesFixture(async (fixture) => {
    await prepareHomeSource(fixture.client, await backendUserName("member", pool));
    const base = {
      source: await digest(homeSourceName),
      pool: (await digest(pool)).slice(0, 16),
      person: await digest("member"),
      provider: "provider-alias",
      model: "model-fixture",
      apiType: "responses",
      inputTokens: "100",
      outputTokens: "20",
      cacheReadTokens: "0",
      cacheWriteTokens: "0",
      totalTokens: "120",
      tokenQuality: "complete" as const,
    };
    await fixture.insert(base, { ...base, model: null }, { ...base, model: "source-failed" });
    const signed = await input({ canManage: true, mappingProven: true, accounts: [] });
    const result = await poolUsageOverview(fixture.db, {
      ...signed,
      prices: [rates("0", "10")],
      priceIssues: [
        {
          provider: base.provider,
          model: "source-failed",
          reason: "Public price refresh failed; no saved price for source-failed.",
        },
      ],
    });
    const slices = result.metrics.usageSlices;
    assert.equal(
      slices.find((slice) => slice.model === null)!.apiReason,
      "Model not recorded; cost cannot be estimated",
    );
    assert.match(
      slices.find((slice) => slice.model === "source-failed")!.apiReason!,
      /Public price refresh failed/,
    );
    assert.equal(
      slices.find((slice) => slice.model === "model-fixture")!.apiBilled,
      "0.001600000000",
    );
  });
});
