import assert from "node:assert/strict";
import { test } from "node:test";
import type { OverviewApiPrice, OverviewPriceTable } from "../../apps/pool/overview-contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { importAccountReference } from "../../src/pool/model-history/import-account-reference.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { seriesAggregates } from "../../src/pool/model-history/series-aggregates.ts";
import type {
  PoolUsageSeriesInput,
  SeriesAuthority,
} from "../../src/pool/model-history/series-contract.ts";
import { utcSql } from "../../src/pool/model-history/series-query.ts";
import { poolPersonalUsageSeries, poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { accountAuthority, input, seriesFixture } from "./series-fixture.ts";

// The former per-request JSON grouping, sharing only the unchanged selection and price calculation.
function legacyGrouping(sql: string, query: PoolUsageSeriesInput, priced: boolean) {
  const start = sql.indexOf(",\n    normalized AS (");
  if (start < 0) return sql;
  const columns = {
    account: "saved_account",
    person: "CASE WHEN attribution = 'import-owner' THEN NULL ELSE person END",
    provider: "provider",
    model: "model",
    app: "app_id",
    source: "source",
    attribution: "attribution",
  };
  const key = ["'currency'", "currency"];
  const redacted = ["'currency'", "NULL", "'account'", "saved_account"];
  for (const dimension of query.by) {
    key.push(`'${dimension}'`, columns[dimension]);
    if (dimension !== "account") redacted.push(`'${dimension}'`, "NULL");
  }
  if (query.by.includes("person") && !query.by.includes("attribution")) {
    key.push(
      "'attribution'",
      "CASE WHEN attribution = 'import-owner' THEN 'import-owner' ELSE NULL END",
    );
    redacted.push("'attribution'", "NULL");
  }
  const timezone = query.timezone ?? "UTC";
  const bucket = `date_trunc('${query.bucket}', (left(timestamp_exact,19)::timestamp AT TIME ZONE 'UTC') AT TIME ZONE '${timezone}')`;
  const suffix = sql.slice(sql.lastIndexOf(" FROM keyed") + " FROM keyed".length);
  return `${sql.slice(0, start)}, keyed AS (SELECT *,
    CASE WHEN counts_only THEN jsonb_build_object(${redacted.join(", ")})
      ELSE jsonb_build_object(${key.join(", ")}) END::text COLLATE "C" AS group_key,
    ${bucket} AT TIME ZONE '${timezone}' AS bucket_at,
    (${bucket} + interval '1 ${query.bucket}') AT TIME ZONE '${timezone}' AS bucket_end
    FROM ${priced ? "priced" : "selected"}),
    aggregated AS (SELECT group_key,bucket_at,bucket_end,${seriesAggregates(priced, true).join(",")}
      FROM keyed GROUP BY group_key,bucket_at,bucket_end)
    SELECT *,${utcSql("bucket_at")} AS at,${utcSql("bucket_end")} AS end_at FROM aggregated${suffix}`;
}

const prices: OverviewPriceTable = {
  prices: [
    { tier: "*", minInput: "0", input: "0.123456789012", version: "base" },
    { tier: "*", minInput: "1000", input: "0.246913578024", version: "long" },
    { tier: "priority", minInput: "0", input: "0.5", version: "priority" },
    { tier: "priority", minInput: "1000", input: "0.75", version: "priority-long" },
  ].map(
    (rate) =>
      ({
        ...rate,
        provider: "synthetic-provider",
        model: "synthetic-model",
        currency: "USD",
        output: "1.25",
        cacheRead: "0.01",
        cacheWrite: rate.version === "base" ? "0" : "0.15",
        request: "0.000000000001",
        asOf: "2026-11-01T00:00:00Z",
        source: "models.dev",
        basis: rate.version === "base" ? "baseline" : "live",
        refreshFailed: rate.version === "base",
      }) satisfies OverviewApiPrice,
  ),
  issues: [],
};

async function equalPages(
  db: HistoryDatabase,
  query: PoolUsageSeriesInput,
  authority: SeriesAuthority,
  priceTable?: OverviewPriceTable,
  person?: string,
) {
  let legacyReads = 0;
  const legacy: HistoryDatabase = {
    query: (sql, values) => {
      const text = legacyGrouping(sql, query, priceTable !== undefined);
      if (text !== sql) legacyReads++;
      return db.query(text, values);
    },
  };
  let after: string | undefined;
  let pages = 0;
  do {
    const current = { ...query, ...(after ? { after } : {}) };
    const expected = person
      ? await poolPersonalUsageSeries(legacy, current, person)
      : await poolUsageSeries(legacy, current, authority, "owned", priceTable);
    const actual = person
      ? await poolPersonalUsageSeries(db, current, person)
      : await poolUsageSeries(db, current, authority, "owned", priceTable);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), JSON.stringify(query));
    after = actual.next ?? undefined;
    assert.ok(++pages < 10);
  } while (after);
  assert.equal(legacyReads, pages, "every expected page must execute the former grouping SQL");
  return pages;
}

test("scalar grouping preserves complete series JSON across retained synthetic rows, prices, redaction, filters and cursors", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const native = await accountAuthority();
    const imported = await digest("synthetic-import");
    const gateway = await digest("pool-gateway-v1");
    const person = await digest("synthetic-person");
    const unknown = await digest("synthetic-unmapped-account");
    const common = {
      source: native.source,
      account: native.visible,
      person,
      provider: "synthetic-provider",
      model: "synthetic-model",
      appId: "synthetic-app",
      timestamp: timestamp("2026-10-25T00:30:00Z"),
      inputTokens: "1000",
      outputTokens: "17",
      cacheReadTokens: "20",
      cacheWriteTokens: "10",
      reasoningTokens: "3",
      totalTokens: "1017",
      tokenQuality: "complete" as const,
      apiType: "responses",
    };
    await insert(
      common,
      {
        ...common,
        inputTokens: "999",
        cost: "1.234567890123",
        currency: "credits",
        costBasis: "home-charge",
      },
      { ...common, inputTokens: "1001", serviceTier: "priority" },
      { ...common, inputTokens: "999", serviceTier: "priority", failed: true, statusCode: 429 },
      { ...common, tokenQuality: "legacy", apiType: "messages" },
      { ...common, tokenQuality: "legacy", apiType: null, totalTokens: "1050" },
      { ...common, tokenQuality: "inconsistent", inputTokens: null },
      {
        ...common,
        account: native.hidden,
        model: "private-model-sentinel",
        currency: "secret-unit",
        cost: "99",
        costBasis: "home-charge",
      },
      { ...common, account: unknown },
      {
        ...common,
        account: null,
        source: gateway,
        person: null,
        provider: null,
        model: null,
        failed: true,
      },
      { ...common, account: unknown, source: gateway, person: null, provider: null, model: null },
      {
        ...common,
        source: imported,
        account: importAccountReference(native.visible),
        attribution: "import-owner",
        timestamp: timestamp("2026-10-25T01:30:00Z"),
      },
      {
        ...common,
        source: imported,
        account: importAccountReference(native.hidden),
        attribution: "import-owner",
      },
      {
        ...common,
        source: imported,
        account: unknown,
        attribution: "import-owner",
        cost: "0.000000000001",
        currency: "USD",
        costBasis: "historical-api-price",
      },
      {
        ...common,
        source: imported,
        account: null,
        person: null,
        model: 'é-"\\model',
        currency: "EUR",
        cost: "2",
        costBasis: "historical-api-price",
      },
    );
    await db.query(`INSERT INTO basalt_model_requests
      SELECT (jsonb_populate_record(NULL::basalt_model_requests, to_jsonb(r) || jsonb_build_object(
        'id',md5(r.id||n)||md5(n||r.id),'source_record',md5(r.source_record||n)||md5(n||r.source_record),
        'timestamp',r.timestamp - (n % 100)*interval '1 day',
        'timestamp_exact',to_char((r.timestamp - (n % 100)*interval '1 day') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'000Z'
      ))).* FROM basalt_model_requests r CROSS JOIN generate_series(1,500) n`);
    await insert(
      { ...common, timestamp: timestamp("2026-07-18T00:00:00Z") },
      { ...common, timestamp: timestamp("2026-07-17T23:59:59.999999999Z") },
      { ...common, timestamp: timestamp("2026-10-25T23:59:59.999999999Z") },
      { ...common, timestamp: timestamp("2026-10-26T00:00:00Z") },
      { ...common, timestamp: timestamp("2026-03-29T00:30:00Z") },
      { ...common, timestamp: timestamp("2026-03-29T01:30:00Z") },
    );
    const range: PoolUsageSeriesInput = {
      ...input,
      from: "2026-07-18T00:00:00Z",
      to: "2026-10-26T00:00:00Z",
      bucket: "day",
      by: ["person", "provider", "model", "source", "attribution"],
    };
    for (const by of [
      range.by,
      [],
      ["account"],
      ["person"],
      ["model", "provider"],
      ["account", "person", "provider", "model", "app", "source", "attribution"],
    ] as const)
      await equalPages(db, { ...range, by }, native.authority, prices);
    await equalPages(db, { ...range, timezone: "Europe/Zurich" }, native.authority, prices);
    await equalPages(
      db,
      { ...range, timezone: "UTC", bucket: "hour", by: ["account"] },
      native.authority,
    );
    await equalPages(db, { ...range, accounts: ["saved-visible"] }, native.authority, prices);
    await equalPages(db, { ...range, sources: [imported] }, native.authority, prices);
    await equalPages(db, range, { ...native.authority, mappingProven: false }, prices);
    await equalPages(
      db,
      { ...range, accounts: ["saved-visible"] },
      { ...native.authority, mappingProven: false },
      prices,
    );
    await equalPages(
      db,
      { ...range, by: ["person", "model", "provider"], sources: [native.source, gateway] },
      native.authority,
      undefined,
      person,
    );
    await equalPages(
      db,
      {
        ...range,
        from: "2026-03-28T00:00:00Z",
        to: "2026-03-30T00:00:00Z",
        timezone: "Europe/Zurich",
      },
      native.authority,
      prices,
    );

    await db.query(`INSERT INTO basalt_model_requests
      SELECT (jsonb_populate_record(NULL::basalt_model_requests, to_jsonb(r) || jsonb_build_object(
        'id',md5('page'||n)||md5(n||'page'),'source_record',md5('page'||n)||md5(n||'page'),
        'model','model-'||lpad(n::text,4,'0')
      ))).* FROM (SELECT * FROM basalt_model_requests WHERE account IS NULL LIMIT 1) r
      CROSS JOIN generate_series(1,620) n`);
    assert.ok((await equalPages(db, { ...range, by: ["model"] }, native.authority, prices)) > 1);
  });
});
