import type { HistoryDatabase } from "./schema.ts";
import { utcSql } from "./series-query.ts";
import {
  maxSummaryCostRows,
  maxSummaryModelRows,
  maxSummaryProviderRows,
  type summarySelection,
} from "./summary-query.ts";
import { maxHeatmapCells, maxSummaryNativeHours } from "./summary-hourly.ts";
import { rollupAggregates, rollupCount as count, rollupPricedSql } from "./summary-rollup-query.ts";

type Selection = Awaited<ReturnType<typeof summarySelection>>;
type Row = Record<string, unknown>;

/** `from`, `previousFrom`, `heatmapFrom` and `heatmapTo` are $9 to $12, after the selection's eight. */
interface FigureBounds {
  from: string;
  previousFrom: string;
  heatmapFrom: string;
  heatmapTo: string;
  models: boolean;
}

/**
 * A rolled summary's coverage, daily figures and hourly figures as one statement over one read of
 * the window's groups. All three parts reference `selected`, so Postgres materializes it once
 * instead of reading the rollup and planning the cut hours' raw rows once per part. The parts'
 * rows differ in shape, so each comes back as JSON text tagged with its part, in that part's own
 * order. The window is the summary's whole read; every boundary the hourly part filters on is one
 * of the window's cuts, so no group straddles it.
 */
export function rollupFiguresQuery(selection: Selection, bounds: FigureBounds) {
  const modelDaily = bounds.models ? ", (counts_only,pv,mv,range_kind,bucket_at,bucket_end)" : "";
  const kind = `CASE WHEN GROUPING(bucket_at)=1 THEN 'cost'
    WHEN GROUPING(range_kind)=1 THEN 'history'
    WHEN GROUPING(mv)=0 THEN 'model' ELSE range_kind END`;
  const key = `CASE WHEN GROUPING(mv)=1 THEN jsonb_build_object('currency',NULL,'provider',pv)
    ELSE jsonb_build_object('currency',NULL,'provider',pv,'model',mv) END::text COLLATE "C"`;
  return {
    text: `${selection.text}, ${rollupPricedSql()},
      coverage AS (
        SELECT source,min(first_at) AS first_at,max(last_at) AS last_at,
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
        FROM selected GROUP BY source ORDER BY source LIMIT 501
      ), daily_keyed AS (
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
        FROM daily_keyed GROUP BY GROUPING SETS (
          (counts_only,pv,bucket_at,bucket_end),
          (counts_only,pv,range_kind,bucket_at,bucket_end),
          (counts_only,pv,mv,eligible)${modelDaily}
        ) HAVING GROUPING(bucket_at)=1 AND eligible
          OR GROUPING(bucket_at)=0 AND GROUPING(range_kind)=1
          OR GROUPING(bucket_at)=0 AND GROUPING(range_kind)=0
            AND (range_kind='current' OR range_kind='previous' AND GROUPING(mv)=1)
      ), daily_ranked AS (
        SELECT *,row_number() OVER (PARTITION BY scope ORDER BY group_key,bucket_at,counts_only) AS row_number
        FROM daily
      ), hour_keyed AS (
        SELECT *,CASE WHEN counts_only THEN NULL ELSE provider END AS pv,hour AS hour_at,
          (extract(isodow FROM hour AT TIME ZONE 'Europe/Zurich')-1)::int AS weekday,
          extract(hour FROM hour AT TIME ZONE 'Europe/Zurich')::int AS clock_hour,
          first_at >= $11::text AND first_at < $12::text AS heat_eligible,
          source=$5 AND NOT counts_only AND first_at >= $9::text AS native_eligible
        FROM selected
      ), hour_aggregated AS (
        SELECT CASE WHEN GROUPING(hour_at)=1 THEN 'heatmap' ELSE 'native' END AS kind,
          pv,weekday,clock_hour,hour_at,${count()} AS requests,
          sum(total_tokens_sum) FILTER (WHERE NOT counts_only)::text AS tokens,
          coalesce(sum(total_tokens_known) FILTER (WHERE NOT counts_only),0)::text AS known,
          (coalesce(sum(requests) FILTER (WHERE counts_only),0)
            + coalesce(sum(requests-total_tokens_known) FILTER (WHERE NOT counts_only),0))::text AS missing
        FROM hour_keyed WHERE heat_eligible OR native_eligible GROUP BY GROUPING SETS (
          (pv,weekday,clock_hour,heat_eligible), (pv,hour_at,native_eligible)
        ) HAVING GROUPING(hour_at)=1 AND heat_eligible OR GROUPING(hour_at)=0 AND native_eligible
      ), hour_samples AS (
        SELECT (extract(isodow FROM at AT TIME ZONE 'Europe/Zurich')-1)::int AS weekday,
          extract(hour FROM at AT TIME ZONE 'Europe/Zurich')::int AS clock_hour,count(*)::text AS hours
        FROM generate_series($11::timestamptz,$12::timestamptz-interval '1 hour',interval '1 hour') AS slots(at)
        GROUP BY weekday,clock_hour
      ), hour_ranked AS (
        SELECT a.*,s.hours,row_number() OVER (
          PARTITION BY kind ORDER BY pv,weekday,clock_hour,hour_at
        ) AS row_number FROM hour_aggregated a LEFT JOIN hour_samples s USING (weekday,clock_hour)
      )
      SELECT 'coverage' AS part,row_number() OVER (ORDER BY source) AS ord,to_json(c)::text AS row
        FROM coverage c
      UNION ALL SELECT 'daily',row_number() OVER (ORDER BY scope,group_key,bucket_at,counts_only),
        to_json(d)::text FROM (
          SELECT *,${utcSql("bucket_at")} AS at,${utcSql("bucket_end")} AS end_at FROM daily_ranked
          WHERE row_number <= CASE scope
            WHEN 'model' THEN ${maxSummaryModelRows + 1}
            WHEN 'cost' THEN ${maxSummaryCostRows + 1}
            ELSE ${maxSummaryProviderRows + 1} END
        ) d
      UNION ALL SELECT 'hourly',row_number() OVER (ORDER BY kind,pv,weekday,clock_hour,hour_at),
        to_json(h)::text FROM (
          SELECT *,${utcSql("hour_at")} AS at FROM hour_ranked
          WHERE row_number <= CASE kind WHEN 'heatmap' THEN ${maxHeatmapCells + 1}
            ELSE ${maxSummaryNativeHours + 1} END
        ) h
      ORDER BY part,ord`,
    values: [
      ...selection.values,
      bounds.from,
      bounds.previousFrom,
      bounds.heatmapFrom,
      bounds.heatmapTo,
    ],
  };
}

/** Runs the rolled figures' one statement and hands each part its rows as the raw path's would be. */
export async function rollupFigures(
  db: HistoryDatabase,
  selection: Selection,
  bounds: FigureBounds,
) {
  const query = rollupFiguresQuery(selection, bounds);
  const parts = { coverage: [] as Row[], daily: [] as Row[], hourly: [] as Row[] };
  for (const row of (await db.query(query.text, query.values)).rows) {
    const name = String(row.part);
    if (!Object.hasOwn(parts, name)) throw new Error("Unknown summary figure part");
    parts[name as keyof typeof parts].push(JSON.parse(String(row.row)) as Row);
  }
  return parts;
}
