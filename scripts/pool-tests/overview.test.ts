import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import type {
  OverviewApiPrice,
  PoolOverviewSignedInput,
} from "../../apps/pool/overview-contract.ts";
import { poolPersonalOverview, poolUsageOverview } from "../../src/pool/model-history/overview.ts";
import { reference, timestamp, type ModelRequest } from "../../src/pool/model-history/record.ts";
import { homeAccountMappingProven } from "../../src/pool/model-history/series-mapping.ts";
import { pool, seriesFixture } from "./series-fixture.ts";

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
    assert.equal(result.metrics.apiBilled.amount, "0.001900000000");
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
    assert.equal(result.metrics.usageSlices.length, 0);
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

test("overview reports zero for a validly priced empty API category and refuses rounded large token percentiles", async () => {
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
    assert.equal(result.metrics.apiBilled.status, "available");
    assert.equal(result.metrics.apiBilled.amount, "0.000000000000");
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
