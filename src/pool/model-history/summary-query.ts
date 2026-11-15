import type { OverviewPriceTable } from "../../../apps/pool/overview-contract.ts";
import type { SeriesAuthority } from "./series-contract.ts";
import { digest } from "../backend-users.ts";
import { accountHistoryReferences, importAccountPrefix } from "./import-account-reference.ts";
import { officialPriceRows } from "./official-cost.ts";
import { pricedRowsSql } from "./overview-sql.ts";
import { seriesAggregates } from "./series-aggregates.ts";
import { utcSql } from "./series-query.ts";

export const maxSummaryProviderRows = 5_000;
export const maxSummaryModelRows = 5_000;
export const maxSummaryCostRows = 500;
export const maxSummaryBytes = 2_097_152;

/** The account policy is the series policy; foreign imports are never native capacity. */
export async function summarySelection(
  pool: string,
  from: string,
  to: string,
  authority: SeriesAuthority,
  prices: OverviewPriceTable = { prices: [], issues: [] },
) {
  const unique = new Map<string, string | null>();
  for (const account of authority.accounts)
    for (const history of account.history.flatMap(accountHistoryReferences)) {
      if (unique.has(history) && unique.get(history) !== account.account)
        throw new Error("Account mapping is ambiguous");
      unique.set(history, account.account);
    }
  const values: unknown[] = [
    (await digest(pool)).slice(0, 16),
    from,
    to,
    JSON.stringify([...unique].map(([history, saved]) => ({ history, saved }))),
    await digest("home-local-v1"),
    await digest("pool-gateway-v1"),
    JSON.stringify(officialPriceRows(prices.prices)),
    authority.mappingProven,
  ];
  const native = `(r.source=$5 OR r.attribution='import-owner' AND left(r.account,${importAccountPrefix.length})='${importAccountPrefix}')`;
  const text = `WITH bindings AS (
      SELECT * FROM jsonb_to_recordset($4::jsonb) AS b(history text,saved text)
    ), selected AS (
      SELECT r.source,r.account,r.attribution,r.timestamp,r.timestamp_exact,r.ingested_at,
        $6::text AS gateway_source,
        r.provider,r.model,r.failed,r.status_code,r.token_quality,r.api_type,r.service_tier,
        r.input_tokens,r.output_tokens,r.cache_read_tokens,r.cache_write_tokens,
        r.reasoning_tokens,r.total_tokens,r.cost,r.currency,r.cost_basis,r.price_snapshot,r.price_version,
        CASE WHEN r.account IS NULL THEN NULL
          WHEN NOT ${native} OR NOT $8::boolean OR b.history IS NULL THEN 'unmapped'
          WHEN b.saved IS NULL THEN 'otherAccounts' ELSE b.saved END AS saved_account,
        (${native} AND r.account IS NOT NULL AND
          (NOT $8::boolean OR b.history IS NULL OR b.saved IS NULL)) AS counts_only
      FROM basalt_model_requests r
      LEFT JOIN bindings b ON ${native} AND r.account=b.history::character(64)
      WHERE r.pool=$1 AND $7::jsonb IS NOT NULL
        AND r.timestamp >= $2::text::timestamptz - interval '1 microsecond'
        AND r.timestamp < $3::text::timestamptz + interval '1 microsecond'
        AND r.timestamp_exact >= $2 AND r.timestamp_exact < $3
    )`;
  return { text, values, homeSource: String(values[4]), gatewaySource: String(values[5]) };
}

type Selection = Awaited<ReturnType<typeof summarySelection>>;

export function summaryPriceTargets(selection: Selection) {
  return {
    text: `${selection.text} SELECT DISTINCT provider,model FROM selected
      WHERE NOT counts_only AND provider IS NOT NULL AND model IS NOT NULL
      ORDER BY provider,model LIMIT 101`,
    values: selection.values,
  };
}

export function summaryCoverageQuery(selection: Selection) {
  return {
    text: `${selection.text} SELECT source,min(timestamp_exact) AS first_at,
      max(timestamp_exact) AS last_at,${utcSql("max(ingested_at)")} AS ingested_at,
      count(*) FILTER (WHERE saved_account NOT IN ('unmapped','otherAccounts'))::text AS mapped,
      count(*) FILTER (WHERE saved_account='unmapped')::text AS unmapped,
      count(*) FILTER (WHERE counts_only AND saved_account='otherAccounts')::text AS other,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis='home-charge')::text AS home_priced,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis='historical-api-price' AND currency='USD')::text AS imported_priced,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis='unpriced')::text AS unpriced,
      count(*) FILTER (WHERE counts_only OR cost_basis='historical-api-price' AND currency<>'USD')::text AS missing,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis<>'unpriced' AND price_snapshot IS NULL)::text AS missing_snapshot,
      count(*) FILTER (WHERE NOT counts_only AND cost_basis<>'unpriced' AND price_version IS NULL)::text AS missing_version
      FROM selected GROUP BY source ORDER BY source LIMIT 501`,
    values: selection.values,
  };
}

/** Grouping sets price each request once, including when a model chart is requested. */
export function summaryDailyQuery(
  selection: Selection,
  from: string,
  previousFrom: string,
  models: boolean,
) {
  const modelDaily = models ? ", (counts_only,pv,mv,range_kind,bucket_at,bucket_end)" : "";
  const kind = `CASE WHEN GROUPING(bucket_at)=1 THEN 'cost'
    WHEN GROUPING(range_kind)=1 THEN 'history'
    WHEN GROUPING(mv)=0 THEN 'model' ELSE range_kind END`;
  const key = `CASE WHEN GROUPING(mv)=1 THEN jsonb_build_object('currency',NULL,'provider',pv)
    ELSE jsonb_build_object('currency',NULL,'provider',pv,'model',mv) END::text COLLATE "C"`;
  return {
    text: `${selection.text}, ${pricedRowsSql("selected", "$7", "NOT s.counts_only", "public_")},
      keyed AS (
        SELECT *,CASE WHEN counts_only THEN NULL ELSE provider END AS pv,
          CASE WHEN counts_only THEN NULL ELSE model END AS mv,
          timestamp_exact >= $9::text AS eligible,
          CASE WHEN timestamp_exact >= $9::text THEN 'current'
            WHEN timestamp_exact >= $10::text THEN 'previous' ELSE 'training' END AS range_kind,
          date_trunc('day',(left(timestamp_exact,19)::timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Zurich') AT TIME ZONE 'Europe/Zurich' AS bucket_at,
          (date_trunc('day',(left(timestamp_exact,19)::timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Zurich') + interval '1 day') AT TIME ZONE 'Europe/Zurich' AS bucket_end
        FROM priced
      ), daily AS (
        SELECT ${kind} AS scope,${key} AS group_key,bucket_at,bucket_end,
          ${seriesAggregates(true, true).join(",\n")}
        FROM keyed GROUP BY GROUPING SETS (
          (counts_only,pv,bucket_at,bucket_end),
          (counts_only,pv,range_kind,bucket_at,bucket_end),
          (counts_only,pv,mv,eligible)${modelDaily}
        ) HAVING GROUPING(bucket_at)=1 AND eligible
          OR GROUPING(bucket_at)=0 AND GROUPING(range_kind)=1
          OR GROUPING(bucket_at)=0 AND GROUPING(range_kind)=0
            AND (range_kind='current' OR range_kind='previous' AND GROUPING(mv)=1)
      ), ranked AS (
        SELECT *,row_number() OVER (PARTITION BY scope ORDER BY group_key,bucket_at,counts_only) AS row_number
        FROM daily
      ) SELECT *,${utcSql("bucket_at")} AS at,${utcSql("bucket_end")} AS end_at
        FROM ranked WHERE row_number <= CASE scope
          WHEN 'model' THEN ${maxSummaryModelRows + 1}
          WHEN 'cost' THEN ${maxSummaryCostRows + 1}
          ELSE ${maxSummaryProviderRows + 1} END
        ORDER BY scope,group_key,bucket_at,counts_only`,
    values: [...selection.values, from, previousFrom],
  };
}
