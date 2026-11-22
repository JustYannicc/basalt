import type { OverviewApiPrice, OverviewPriceIssue } from "../../../apps/pool/overview-contract.ts";
import { importAccountPrefix } from "./import-account-reference.ts";
import { utcSql } from "./series-query.ts";
import {
  maxSummaryCostRows,
  maxSummaryModelRows,
  maxSummaryProviderRows,
} from "./summary-query.ts";
import type { summarySelection } from "./summary-query.ts";
import { usageRollupBands, usageRollupProjection } from "./usage-rollup-schema.ts";
import { maxSummaryNativeHours } from "./summary-hourly.ts";

type Selection = Awaited<ReturnType<typeof summarySelection>>;

const exact = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z$/;
const hourOf = (at: string) => `${at.slice(0, 13)}:00:00.000000000Z`;
const nextHour = (at: string) =>
  `${new Date(Date.parse(hourOf(at).slice(0, 19) + "Z") + 3_600_000).toISOString().slice(0, 19)}.000000000Z`;

/**
 * Splits a window into whole hours the rollup answers and the few hours that contain a boundary off
 * the hour, which are read from raw rows cut at those boundaries, so no group ever straddles one.
 */
export function rollupWindow(from: string, to: string, boundaries: readonly string[]) {
  for (const at of [from, to, ...boundaries])
    if (!exact.test(at)) throw new Error("Rollup boundaries must be exact timestamps");
  const cuts = [...new Set([from, to, ...boundaries])]
    .filter((at) => at >= from && at <= to)
    .sort();
  const split = [...new Set(cuts.filter((at) => at !== hourOf(at)).map(hourOf))].sort();
  const segments = split.flatMap((start) => {
    const end = nextHour(start);
    const points = [...new Set([start, end, ...cuts.filter((at) => at > start && at < end)])]
      .map((at) => (at < from ? from : at > to ? to : at))
      .sort();
    return points.slice(1).flatMap((b, index) => (points[index]! < b ? [[points[index]!, b]] : []));
  });
  return { from: from === hourOf(from) ? from : nextHour(from), to: hourOf(to), split, segments };
}

const literal = (at: string) => {
  if (!exact.test(at)) throw new Error("Rollup boundaries must be exact timestamps");
  return `'${at}'`;
};

/**
 * The summary's request selection, as groups: whole hours from the rollup and hours cut by a
 * boundary aggregated from their raw rows, with the same account mapping and redaction as raw rows.
 */
export function rollupSelectionText(window: ReturnType<typeof rollupWindow>, name = "selected") {
  const native = `(r.source=$5 OR r.attribution='import-owner' AND left(r.account,${importAccountPrefix.length})='${importAccountPrefix}')`;
  const raw = window.segments.map(([a, b]) =>
    usageRollupProjection(`(SELECT * FROM basalt_model_requests e
      WHERE e.pool=$1 AND e.timestamp >= ${literal(a!)}::timestamptz - interval '1 microsecond'
        AND e.timestamp < ${literal(b!)}::timestamptz + interval '1 microsecond'
        AND e.timestamp_exact >= ${literal(a!)} AND e.timestamp_exact < ${literal(b!)})`),
  );
  return `${name} AS (
      SELECT r.*,$6::text AS gateway_source,
        CASE WHEN r.account IS NULL THEN NULL
          WHEN NOT ${native} OR NOT $8::boolean OR b.history IS NULL THEN 'unmapped'
          WHEN b.saved IS NULL THEN 'otherAccounts' ELSE b.saved END AS saved_account,
        (${native} AND r.account IS NOT NULL AND
          (NOT $8::boolean OR b.history IS NULL OR b.saved IS NULL)) AS counts_only
      FROM (
        SELECT u.* FROM basalt_model_usage_hourly u
        WHERE u.pool=$1 AND u.hour >= ${literal(window.from)}::timestamptz
          AND u.hour < ${literal(window.to)}::timestamptz
          ${window.split.length ? `AND u.hour NOT IN (${window.split.map((at) => `${literal(at)}::timestamptz`).join(",")})` : ""}
        ${raw.map((sql) => `UNION ALL ${sql}`).join("\n")}
      ) r
      LEFT JOIN bindings b ON ${native} AND r.account=b.history::character(64)
      -- The window's bounds are its cuts above; the shared parameters stay typed.
      WHERE $7::jsonb IS NOT NULL AND $2::text IS NOT NULL AND $3::text IS NOT NULL
    )`;
}

export function rollupSelection(selection: Selection, boundaries: readonly string[]): Selection {
  const window = rollupWindow(String(selection.values[1]), String(selection.values[2]), boundaries);
  return {
    ...selection,
    text: `WITH bindings AS (
      SELECT * FROM jsonb_to_recordset($4::jsonb) AS b(history text,saved text)
    ), ${rollupSelectionText(window)}`,
  };
}

const count = (filter?: string) =>
  `coalesce(sum(requests)${filter ? ` FILTER (WHERE ${filter})` : ""},0)::text`;

export function rollupCoverageQuery(selection: Selection) {
  return {
    text: `${selection.text} SELECT source,min(first_at) AS first_at,max(last_at) AS last_at,
      ${utcSql("max(ingested_at)")} AS ingested_at,
      ${count("saved_account NOT IN ('unmapped','otherAccounts')")} AS mapped,
      ${count("saved_account='unmapped'")} AS unmapped,
      ${count("counts_only AND saved_account='otherAccounts'")} AS other,
      ${count("NOT counts_only AND cost_basis='home-charge'")} AS home_priced,
      ${count("NOT counts_only AND cost_basis='historical-api-price' AND currency='USD'")} AS imported_priced,
      ${count("NOT counts_only AND cost_basis='unpriced'")} AS unpriced,
      ${count("counts_only OR cost_basis='historical-api-price' AND currency<>'USD'")} AS missing,
      ${count("NOT counts_only AND cost_basis<>'unpriced' AND NOT has_snapshot")} AS missing_snapshot,
      ${count("NOT counts_only AND cost_basis<>'unpriced' AND NOT has_version")} AS missing_version
      FROM selected GROUP BY source ORDER BY source LIMIT 501`,
    values: selection.values,
  };
}

const tokens = {
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_tokens",
  cacheWrite: "cache_write_tokens",
  reasoning: "reasoning_tokens",
  total: "total_tokens",
} as const;

/** The series aggregates over groups: every count is a sum of group counts, every sum of sums. */
function rollupAggregates() {
  return [
    `${count()} AS requests`,
    `${count("failed")} AS failed`,
    `${count("limited")} AS limited`,
    `${count("failed AND account IS NULL AND source = $6")} AS unassigned`,
    "max(last_at) FILTER (WHERE NOT failed) AS last_success",
    ...Object.entries(tokens).flatMap(([name, column]) => [
      `sum(${column}_sum)::text AS "${name}Sum"`,
      `coalesce(sum(${column}_known),0)::text AS "${name}Known"`,
      `coalesce(sum(requests-${column}_known),0)::text AS "${name}Missing"`,
    ]),
    ...["complete", "legacy", "unclassified", "inconsistent"].map(
      (quality) => `${count(`token_quality = '${quality}'`)} AS ${quality}`,
    ),
    "sum(cost_sum) FILTER (WHERE cost_basis = 'home-charge')::text AS home_amount",
    `${count("cost_basis = 'home-charge'")} AS home_priced`,
    "sum(cost_sum) FILTER (WHERE cost_basis = 'historical-api-price' AND currency = 'USD')::text AS imported_amount",
    `${count("cost_basis = 'historical-api-price' AND currency = 'USD'")} AS imported_priced`,
    `${count("cost_basis = 'unpriced'")} AS unpriced`,
    ...["charge-snapshot", "key-at-capture", "import-owner", "unknown"].map(
      (kind) => `${count(`attribution = '${kind}'`)} AS "${kind}"`,
    ),
    "round(sum(api_cost),12)::text AS api_amount",
    `${count("api_cost IS NOT NULL")} AS api_priced`,
    `${count("api_cost IS NOT NULL AND token_count_estimate")} AS api_token_count_estimates`,
    "min(public_price_as_of) FILTER (WHERE api_cost IS NOT NULL) AS api_price_as_of",
    "string_agg(DISTINCT public_price_version, ',' ORDER BY public_price_version) FILTER (WHERE api_cost IS NOT NULL) AS api_price_version",
    "bool_or(public_price_basis='baseline') FILTER (WHERE api_cost IS NOT NULL) AS api_price_baseline",
    "bool_or(public_price_refresh_failed) FILTER (WHERE api_cost IS NOT NULL) AS api_price_refresh_failed",
    `${count("public_price_version IS NULL")} AS api_missing_prices`,
    `${count("price_class = 'missing_tokens'")} AS api_missing_tokens`,
    "bool_or(counts_only) AS counts_only",
  ];
}

/**
 * Prices each group as the raw path prices each of its requests. Within one group the rate, the
 * formula and every clamp are fixed, so the cost of the group's sums is the sum of its costs.
 */
function rollupPricedSql() {
  const records = `jsonb_to_recordset($7::jsonb) AS x(provider text,model text,currency text,input text,
    output text,cache_read text,cache_write text,request text,tier text,min_input text,as_of text,
    source text,version text,basis text,refresh_failed boolean)`;
  // The price table is parsed once; each group then picks its rate from the parsed rows.
  return `price_rows AS MATERIALIZED (
      SELECT x.*,x.min_input::numeric AS min_input_tokens FROM ${records}
      WHERE x.currency='USD' AND x.source='models.dev'
    ), priced AS (
      SELECT s.*,p.price_version AS public_price_version,p.price_as_of AS public_price_as_of,
        p.price_basis AS public_price_basis,p.price_refresh_failed AS public_price_refresh_failed,
        (s.token_quality='legacy' AND coalesce(s.api_type,'') NOT IN ('responses','responses-compact','messages')) AS token_count_estimate,
        CASE WHEN p.price_version IS NULL OR s.price_class<>'priced' THEN NULL
        WHEN s.token_quality='complete' THEN
          ((s.input_tokens_sum-s.cache_read_tokens_sum-s.cache_write_tokens_sum)*p.input_rate
          + s.output_tokens_sum*p.output_rate + s.cache_read_tokens_sum*p.cache_read_rate
          + CASE WHEN p.cache_write_rate=0 THEN s.cache_write_tokens_sum*p.input_rate
            ELSE s.cache_write_tokens_sum*p.cache_write_rate END)/1000000 + s.requests*p.request_rate
        WHEN s.api_type IN ('responses','responses-compact') THEN
          (CASE WHEN p.cache_write_rate>0 THEN s.unwritten_input_sum ELSE s.uncached_input_sum END*p.input_rate
          + s.output_tokens_sum*p.output_rate + s.cache_read_tokens_sum*p.cache_read_rate
          + CASE WHEN p.cache_write_rate>0 THEN s.cache_write_tokens_sum*p.cache_write_rate ELSE 0 END)/1000000
          + s.requests*p.request_rate
        WHEN s.api_type='messages' THEN
          (s.input_tokens_sum*p.input_rate + s.output_tokens_sum*p.output_rate
          + s.cache_read_tokens_sum*p.cache_read_rate + s.cache_write_tokens_sum*p.cache_write_rate)/1000000
          + s.requests*p.request_rate
        ELSE
          ((s.context_input_sum-s.cache_read_tokens_sum-s.cache_write_tokens_sum)*p.input_rate
          + s.output_total_sum*p.output_rate + s.cache_read_tokens_sum*p.cache_read_rate
          + s.cache_write_tokens_sum*CASE WHEN p.cache_write_rate=0 THEN p.input_rate ELSE p.cache_write_rate END)/1000000
          + s.requests*p.request_rate
        END AS api_cost
      FROM selected s LEFT JOIN LATERAL (
        SELECT version AS price_version,as_of AS price_as_of,basis AS price_basis,refresh_failed AS price_refresh_failed,
          input::numeric AS input_rate,output::numeric AS output_rate,cache_read::numeric AS cache_read_rate,
          cache_write::numeric AS cache_write_rate,request::numeric AS request_rate
        FROM price_rows x
        WHERE x.provider=s.provider AND x.model=s.model
          AND (x.tier='*' OR x.tier=coalesce(s.service_tier,'*')) AND x.min_input_tokens<=s.context_band
        ORDER BY (x.tier<>'*') DESC,x.min_input_tokens DESC LIMIT 1
      ) p ON NOT s.counts_only
    )`;
}

/** The raw daily statement's grouping sets, over hours instead of requests. */
export function rollupDailyQuery(
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
    text: `${selection.text}, ${rollupPricedSql()},
      keyed AS (
        SELECT *,CASE WHEN counts_only THEN NULL ELSE provider END AS pv,
          CASE WHEN counts_only THEN NULL ELSE model END AS mv,
          first_at >= $9::text AS eligible,
          CASE WHEN first_at >= $9::text THEN 'current'
            WHEN first_at >= $10::text THEN 'previous' ELSE 'training' END AS range_kind,
          date_trunc('day',hour AT TIME ZONE 'Europe/Zurich') AT TIME ZONE 'Europe/Zurich' AS bucket_at,
          (date_trunc('day',hour AT TIME ZONE 'Europe/Zurich') + interval '1 day') AT TIME ZONE 'Europe/Zurich' AS bucket_end
        FROM priced
      ), daily AS (
        SELECT ${kind} AS scope,${key} AS group_key,bucket_at,bucket_end,
          ${rollupAggregates().join(",\n")}
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

/** The raw hourly statement over hours: the heatmap and the native requests per hour. */
export function rollupHourlyText(selection: Selection, maxHeatmapCells: number) {
  return `${selection.text}, keyed AS (
      SELECT *,CASE WHEN counts_only THEN NULL ELSE provider END AS pv,hour AS hour_at,
        (extract(isodow FROM hour AT TIME ZONE 'Europe/Zurich')-1)::int AS weekday,
        extract(hour FROM hour AT TIME ZONE 'Europe/Zurich')::int AS clock_hour,
        first_at >= $9::text AND first_at < $11::text AS heat_eligible,
        source=$5 AND NOT counts_only AND first_at >= $10::text AS native_eligible
      FROM selected
    ), aggregated AS (
      SELECT CASE WHEN GROUPING(hour_at)=1 THEN 'heatmap' ELSE 'native' END AS kind,
        pv,weekday,clock_hour,hour_at,${count()} AS requests,
        sum(total_tokens_sum) FILTER (WHERE NOT counts_only)::text AS tokens,
        coalesce(sum(total_tokens_known) FILTER (WHERE NOT counts_only),0)::text AS known,
        (coalesce(sum(requests) FILTER (WHERE counts_only),0)
          + coalesce(sum(requests-total_tokens_known) FILTER (WHERE NOT counts_only),0))::text AS missing
      FROM keyed WHERE heat_eligible OR native_eligible GROUP BY GROUPING SETS (
        (pv,weekday,clock_hour,heat_eligible), (pv,hour_at,native_eligible)
      ) HAVING GROUPING(hour_at)=1 AND heat_eligible OR GROUPING(hour_at)=0 AND native_eligible
    ), samples AS (
      SELECT (extract(isodow FROM at AT TIME ZONE 'Europe/Zurich')-1)::int AS weekday,
        extract(hour FROM at AT TIME ZONE 'Europe/Zurich')::int AS clock_hour,count(*)::text AS hours
      FROM generate_series($9::timestamptz,$11::timestamptz-interval '1 hour',interval '1 hour') AS slots(at)
      GROUP BY weekday,clock_hour
    ), ranked AS (
      SELECT a.*,s.hours,row_number() OVER (
        PARTITION BY kind ORDER BY pv,weekday,clock_hour,hour_at
      ) AS row_number FROM aggregated a LEFT JOIN samples s USING (weekday,clock_hour)
    ) SELECT *,${utcSql("hour_at")} AS at FROM ranked
      WHERE row_number <= CASE kind WHEN 'heatmap' THEN ${maxHeatmapCells + 1}
        ELSE ${maxSummaryNativeHours + 1} END
      ORDER BY kind,pv,weekday,clock_hour,hour_at`;
}

/**
 * The summary's first statement. A pool whose rollup is ready reads its targets from the rollup;
 * any other pool keeps the raw read behind its bounded window count. One row says which ran.
 */
/** The most rollup groups one summary window may read; past it the summary refuses instead. */
export const maxSummaryRollupGroups = 400_000;

/**
 * The summary's first statement. A pool whose rollup is ready reads its targets from the rollup,
 * behind a bounded count of its window's groups; any other pool keeps the raw read behind its
 * bounded window count. Without the rollup's tables (before v15 is applied) only the raw read is
 * named. One row says which ran.
 */
export function summaryModeTargets(
  selection: Selection,
  windowRows: number,
  boundaries: readonly string[],
  rollupTables = true,
  rollupGroups = maxSummaryRollupGroups,
) {
  for (const bound of [windowRows, rollupGroups])
    if (!Number.isSafeInteger(bound) || bound < 1) throw new Error("Invalid window bound");
  const window = rollupWindow(String(selection.values[1]), String(selection.values[2]), boundaries);
  const rolled = rollupTables
    ? `${rollupSelectionText(window, "rolled")},
    ready AS MATERIALIZED (
      SELECT EXISTS (SELECT 1 FROM basalt_model_usage_ready WHERE pool=$1) AS rolled
    ), rolled_rows AS MATERIALIZED (
      SELECT count(*) AS n FROM (SELECT 1 FROM basalt_model_usage_hourly g
        WHERE (SELECT rolled FROM ready) AND g.pool=$1
          AND g.hour >= '${window.from}'::timestamptz AND g.hour < '${window.to}'::timestamptz
        LIMIT ${rollupGroups + 1}) bounded
    ),`
    : `ready AS MATERIALIZED (SELECT false AS rolled), rolled_rows AS MATERIALIZED (SELECT 0::bigint AS n),`;
  return {
    text: `${selection.text}, ${rolled}
    window_rows AS MATERIALIZED (
      SELECT count(*) AS n FROM (SELECT 1 FROM basalt_model_requests w
        WHERE NOT (SELECT rolled FROM ready) AND w.pool=$1
          AND w.timestamp >= $2::text::timestamptz - interval '1 microsecond'
          AND w.timestamp < $3::text::timestamptz + interval '1 microsecond'
        LIMIT ${windowRows + 1}) bounded
    ), targets AS (
      SELECT DISTINCT provider,model FROM (
        SELECT provider,model,counts_only FROM selected
        WHERE NOT (SELECT rolled FROM ready) AND (SELECT n FROM window_rows) <= ${windowRows}
        ${
          rollupTables
            ? `UNION ALL
        SELECT provider,model,counts_only FROM rolled
        WHERE (SELECT rolled FROM ready) AND (SELECT n FROM rolled_rows) <= ${rollupGroups}`
            : ""
        }
      ) t WHERE NOT counts_only AND provider IS NOT NULL AND model IS NOT NULL
      ORDER BY provider,model LIMIT 101
    ) SELECT 'target' AS kind,provider,model,NULL::bigint AS window_rows FROM targets
      UNION ALL SELECT 'over',NULL,NULL,n FROM window_rows WHERE n > ${windowRows}
      UNION ALL SELECT 'over',NULL,NULL,n FROM rolled_rows WHERE n > ${rollupGroups}
      UNION ALL SELECT 'rollup',NULL,NULL,NULL WHERE (SELECT rolled FROM ready)
      ORDER BY kind,provider,model`,
    values: selection.values,
  };
}

/**
 * Drops every price of a pair with a tier the rollup's bands cannot separate, so the rollup read
 * stays exact and bounded: that pair's requests count as missing a price, with the reason.
 */
export function rollupSupportedPrices(table: {
  prices: readonly OverviewApiPrice[];
  issues: readonly OverviewPriceIssue[];
}) {
  const bands = new Set<string>(usageRollupBands.map(String));
  const unsupported = new Set(
    table.prices
      .filter((price) => !bands.has(String(price.minInput)))
      .map((price) => `${price.provider}\u0000${price.model}`),
  );
  if (!unsupported.size) return table;
  return {
    prices: table.prices.filter(
      (price) => !unsupported.has(`${price.provider}\u0000${price.model}`),
    ),
    issues: [
      ...table.issues,
      ...[...unsupported].map((key) => {
        const [provider, model] = key.split("\u0000") as [string, string];
        return {
          provider,
          model,
          reason: `A ${model} price tier is not one the usage rollup separates; its estimate is unavailable.`,
        };
      }),
    ],
  };
}
