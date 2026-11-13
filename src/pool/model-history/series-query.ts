import type { OverviewPriceTable } from "../../../apps/pool/overview-contract.ts";
import { officialPriceRows } from "./official-cost.ts";
import { pricedRowsSql } from "./overview-sql.ts";
import { digest } from "../backend-users.ts";
import type { HistoryDatabase } from "./schema.ts";
import { appAttributionReady } from "./schema.ts";
import { timestamp } from "./record.ts";
import { accountHistoryReferences, importAccountPrefix } from "./import-account-reference.ts";
import { seriesBounds, type SeriesCursor } from "./series-input.ts";
import type { PoolUsageSeriesInput, SeriesAuthority } from "./series-contract.ts";

export const tokenColumns = {
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_tokens",
  cacheWrite: "cache_write_tokens",
  reasoning: "reasoning_tokens",
  total: "total_tokens",
} as const;
const dimensionColumns = {
  person: "person",
  model: "model",
  provider: "provider",
  app: "app_id",
  attribution: "attribution",
  source: "source",
};
export const utcSql = (value: string) =>
  `to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function seriesQuery(
  db: HistoryDatabase,
  input: PoolUsageSeriesInput,
  authority: SeriesAuthority,
  after?: SeriesCursor,
  personScope?: string,
  prices?: OverviewPriceTable,
) {
  const source = await digest("home-local-v1"),
    gateway = await digest("pool-gateway-v1");
  const { from, to } = seriesBounds(input);
  const selected = !authority.mappingProven
    ? []
    : input.accounts === undefined
      ? authority.accounts
      : authority.accounts.filter(
          (account) => account.account !== null && input.accounts!.includes(account.account),
        );
  const bindings = selected.flatMap((account) =>
    account.history.flatMap((home) =>
      accountHistoryReferences(home).map((history) => ({ history, saved: account.account })),
    ),
  );
  const unique = new Map<string, string | null>();
  for (const binding of bindings) {
    if (unique.has(binding.history) && unique.get(binding.history) !== binding.saved)
      throw new Error("Account mapping is ambiguous");
    unique.set(binding.history, binding.saved);
  }
  const values: unknown[] = [
    (await digest(input.pool)).slice(0, 16),
    from,
    to,
    JSON.stringify([...unique].map(([history, saved]) => ({ history, saved }))),
    source,
    gateway,
    authority.mappingProven,
  ];
  let where = "",
    accountWhere = "";
  const nativeAccount = `(r.source = $5 OR r.attribution = 'import-owner' AND left(r.account, ${importAccountPrefix.length}) = '${importAccountPrefix}')`;
  if (input.accounts !== undefined) {
    if (authority.mappingProven) {
      values.push([...unique.keys()]);
      accountWhere = ` AND r.account = ANY($${values.length}::character(64)[]) AND ${nativeAccount}`;
    } else accountWhere = " AND false";
  }
  if (input.sources !== undefined) {
    values.push(input.sources);
    where += ` AND r.source = ANY($${values.length}::text[])`;
  }
  let personalWhere = "";
  if (personScope !== undefined) {
    values.push(personScope);
    personalWhere = ` AND r.person = $${values.length}::character(64) AND r.attribution IS DISTINCT FROM 'import-owner'`;
  }
  const priceParameter = prices
    ? `$${values.push(JSON.stringify(officialPriceRows(prices.prices)))}`
    : undefined;
  const columns = Object.entries(tokenColumns).flatMap(([name, column]) => [
    `sum(${column})::text AS "${name}Sum"`,
    `count(${column})::text AS "${name}Known"`,
    `count(*) FILTER (WHERE ${column} IS NULL)::text AS "${name}Missing"`,
  ]);
  const aggregates = [
    "count(*)::text AS requests",
    "count(*) FILTER (WHERE failed)::text AS failed",
    "count(*) FILTER (WHERE failed AND account IS NULL AND source = $6)::text AS unassigned",
    "max(timestamp_exact) FILTER (WHERE NOT failed) AS last_success",
    ...columns,
    ...["complete", "legacy", "unclassified", "inconsistent"].map(
      (quality) => `count(*) FILTER (WHERE token_quality = '${quality}')::text AS ${quality}`,
    ),
    "sum(cost) FILTER (WHERE cost_basis = 'home-charge')::text AS home_amount",
    "count(*) FILTER (WHERE cost_basis = 'home-charge')::text AS home_priced",
    "sum(cost) FILTER (WHERE cost_basis = 'historical-api-price' AND currency = 'USD')::text AS imported_amount",
    "count(*) FILTER (WHERE cost_basis = 'historical-api-price' AND currency = 'USD')::text AS imported_priced",
    "count(*) FILTER (WHERE cost_basis = 'unpriced')::text AS unpriced",
    ...["charge-snapshot", "key-at-capture", "import-owner", "unknown"].map(
      (kind) => `count(*) FILTER (WHERE attribution = '${kind}')::text AS "${kind}"`,
    ),
    ...(prices
      ? [
          "round(sum(api_cost),12)::text AS api_amount",
          "count(api_cost)::text AS api_priced",
          "count(*) FILTER (WHERE api_cost IS NOT NULL AND token_count_estimate)::text AS api_token_count_estimates",
          "min(public_price_as_of) FILTER (WHERE api_cost IS NOT NULL) AS api_price_as_of",
          "string_agg(DISTINCT public_price_version, ',' ORDER BY public_price_version) FILTER (WHERE api_cost IS NOT NULL) AS api_price_version",
          "bool_or(public_price_basis='baseline') FILTER (WHERE api_cost IS NOT NULL) AS api_price_baseline",
          "bool_or(public_price_refresh_failed) FILTER (WHERE api_cost IS NOT NULL) AS api_price_refresh_failed",
          "count(*) FILTER (WHERE public_price_version IS NULL)::text AS api_missing_prices",
          "count(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL OR cache_read_tokens IS NULL OR cache_write_tokens IS NULL OR token_quality NOT IN ('complete','legacy'))::text AS api_missing_tokens",
        ]
      : []),
    "bool_or(counts_only) AS counts_only",
  ];
  const key = ["'currency'", "currency"];
  const redactedKey = ["'currency'", "NULL", "'account'", "saved_account"];
  for (const dimension of input.by)
    key.push(
      `'${dimension}'`,
      dimension === "account"
        ? "saved_account"
        : dimension === "person"
          ? "CASE WHEN attribution = 'import-owner' THEN NULL ELSE person END"
          : dimensionColumns[dimension],
    );
  for (const dimension of input.by)
    if (dimension !== "account") redactedKey.push(`'${dimension}'`, "NULL");
  // Import-owner person groups remain separate even when attribution was not explicitly selected.
  if (input.by.includes("person") && !input.by.includes("attribution"))
    key.push(
      "'attribution'",
      "CASE WHEN attribution = 'import-owner' THEN 'import-owner' ELSE NULL END",
    );
  if (input.by.includes("person") && !input.by.includes("attribution"))
    redactedKey.push("'attribution'", "NULL");
  const app = (await appAttributionReady(db)) ? "r.app_id" : "NULL::text AS app_id";
  // Totals scan imported history too; hash foreign identities only for account drill-downs.
  const foreignAccount = input.by.includes("account")
    ? "'imported:' || encode(sha256(convert_to($1::text || ':' || r.source || ':' || r.account, 'UTF8')), 'hex')"
    : "'unmapped'";
  const prefix = `WITH bindings AS (SELECT * FROM jsonb_to_recordset($4::jsonb) AS b(history text,saved text)),
    selected AS (SELECT r.*, $6::text AS gateway_source,
      ${app === "r.app_id" ? "" : `${app},`}
      CASE WHEN r.account IS NULL THEN NULL
        WHEN NOT ${nativeAccount} AND r.source <> $6 THEN ${foreignAccount}
        WHEN NOT ${nativeAccount} OR NOT $7::boolean OR b.history IS NULL THEN 'unmapped'
        WHEN b.saved IS NULL THEN 'otherAccounts' ELSE b.saved END AS saved_account,
      ${personScope === undefined ? `(${nativeAccount} AND r.account IS NOT NULL AND (NOT $7::boolean OR b.history IS NULL OR b.saved IS NULL))` : "false"} AS counts_only
      FROM basalt_model_requests r LEFT JOIN bindings b ON ${nativeAccount} AND r.account = b.history::character(64)
      WHERE r.pool = $1
        AND r.timestamp >= $2::text::timestamptz - interval '1 microsecond'
        AND r.timestamp < $3::text::timestamptz + interval '1 microsecond'
        AND r.timestamp_exact >= $2::text AND r.timestamp_exact < $3::text${where}${personalWhere}ACCOUNT_FILTER),
    ${prices ? `${pricedRowsSql("selected", priceParameter!, "s.source=$5 AND NOT s.counts_only", "public_")},` : ""}
    keyed AS (SELECT *, CASE WHEN counts_only THEN jsonb_build_object(${redactedKey.join(", ")})
      ELSE jsonb_build_object(${key.join(", ")}) END::text COLLATE "C" AS group_key,
      date_trunc('${input.bucket}', left(timestamp_exact,19)::timestamp) AT TIME ZONE 'UTC' AS bucket_at
      FROM ${prices ? "priced" : "selected"})`;
  const aggregate = `${prefix.replace("ACCOUNT_FILTER", accountWhere)}, aggregated AS (SELECT group_key, bucket_at, ${aggregates.join(",\n      ")}
      FROM keyed GROUP BY group_key,bucket_at)
    SELECT *, ${utcSql("bucket_at")} AS at FROM aggregated`;
  let condition = "";
  if (after) {
    values.push(after.key, timestamp(after.at));
    condition = ` WHERE (group_key,bucket_at) > ($${values.length - 1}::text COLLATE "C",$${values.length}::timestamptz)`;
  }
  return {
    text: `${aggregate}${condition} ORDER BY group_key,bucket_at LIMIT 5001`,
    values,
    coverageText: `${prefix.replace("ACCOUNT_FILTER", authority.mappingProven ? accountWhere : "")} SELECT source, min(timestamp_exact) AS first_at,max(timestamp_exact) AS last_at,
      ${utcSql("max(ingested_at)")} AS ingested_at, count(*)::text AS requests,
      count(*) FILTER (WHERE saved_account NOT IN ('unmapped','otherAccounts') AND saved_account NOT LIKE 'imported:%')::text AS mapped,
      count(*) FILTER (WHERE saved_account = 'unmapped' OR saved_account LIKE 'imported:%')::text AS unmapped,
      count(*) FILTER (WHERE counts_only AND saved_account = 'otherAccounts')::text AS other,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis = 'home-charge')::text AS home_priced,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis = 'historical-api-price' AND currency = 'USD')::text AS imported_priced,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis = 'unpriced')::text AS unpriced,
      count(*) FILTER (WHERE counts_only OR cost_basis = 'historical-api-price' AND currency <> 'USD')::text AS missing,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis <> 'unpriced' AND price_snapshot IS NULL)::text AS missing_snapshot,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis <> 'unpriced' AND price_version IS NULL)::text AS missing_version
      FROM keyed GROUP BY source ORDER BY source LIMIT 501`,
    coverageValues: values.slice(0, after ? -2 : undefined),
    targetsText: `${prefix.replace("ACCOUNT_FILTER", accountWhere)} SELECT DISTINCT provider,model FROM keyed WHERE NOT counts_only AND source=$5 AND provider IS NOT NULL AND model IS NOT NULL ORDER BY provider,model LIMIT 101`,
    targetsValues: values.slice(0, after ? -2 : undefined),
    homeSource: source,
    gatewaySource: gateway,
  };
}
