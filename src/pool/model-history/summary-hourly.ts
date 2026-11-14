import type { UsageSummaryHeatmap } from "../../../apps/pool/usage-overview-contract.ts";
import type { HistoryDatabase } from "./schema.ts";
import type { summarySelection } from "./summary-query.ts";
import { requestCount } from "./series-coverage.ts";
import { timestamp } from "./record.ts";
import { utcSql } from "./series-query.ts";

export const maxSummaryNativeHours = 12_000;
const maxHeatmapCells = 5_000;

export async function summaryHourly(
  db: HistoryDatabase,
  selection: Awaited<ReturnType<typeof summarySelection>>,
  from: string,
  heatmapFrom: string,
  to: string,
) {
  const heatmapTo = new Date(Math.floor(Date.parse(to) / 3_600_000) * 3_600_000).toISOString();
  const wall = "(left(timestamp_exact,19)::timestamp AT TIME ZONE 'UTC')";
  const query = `${selection.text}, keyed AS (
      SELECT *,CASE WHEN counts_only THEN NULL ELSE provider END AS pv,
        date_trunc('hour',${wall}) AS hour_at,
        (extract(isodow FROM ${wall} AT TIME ZONE 'Europe/Zurich')-1)::int AS weekday,
        extract(hour FROM ${wall} AT TIME ZONE 'Europe/Zurich')::int AS clock_hour,
        timestamp_exact >= $9::text AND timestamp_exact < $11::text AS heat_eligible,
        source=$5 AND NOT counts_only AND timestamp_exact >= $10::text AS native_eligible
      FROM selected
    ), aggregated AS (
      SELECT CASE WHEN GROUPING(hour_at)=1 THEN 'heatmap' ELSE 'native' END AS kind,
        pv,weekday,clock_hour,hour_at,count(*)::text AS requests,
        sum(total_tokens) FILTER (WHERE NOT counts_only)::text AS tokens,
        count(total_tokens) FILTER (WHERE NOT counts_only)::text AS known,
        count(*) FILTER (WHERE counts_only OR total_tokens IS NULL)::text AS missing
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
  const rows = (
    await db.query(query, [...selection.values, heatmapFrom, from, timestamp(heatmapTo)])
  ).rows;
  const heatRows = rows.filter((row) => row.kind === "heatmap");
  const nativeRows = rows.filter((row) => row.kind === "native");
  const heatmap: UsageSummaryHeatmap = {
    from: heatmapFrom,
    to: timestamp(heatmapTo),
    basis: "recorded-usage",
    status: heatRows.length > maxHeatmapCells ? "unavailable" : "available",
    ...(heatRows.length > maxHeatmapCells
      ? { reason: "The heatmap exceeds its bounded response." }
      : {}),
    cells:
      heatRows.length > maxHeatmapCells
        ? []
        : heatRows.map((row) => ({
            provider: typeof row.pv === "string" ? row.pv : null,
            weekday: Number(row.weekday),
            hour: Number(row.clock_hour),
            requests: requestCount(row.requests),
            tokens: {
              sum: row.tokens === null ? null : String(row.tokens),
              known: requestCount(row.known),
              missing: requestCount(row.missing),
            },
            sampleHours: requestCount(row.hours),
          })),
  };
  return {
    heatmap,
    nativeAvailable: nativeRows.length <= maxSummaryNativeHours,
    native:
      nativeRows.length > maxSummaryNativeHours
        ? []
        : nativeRows.flatMap((row) =>
            typeof row.pv === "string"
              ? [
                  {
                    provider: row.pv,
                    at: timestamp(String(row.at)),
                    requests: requestCount(row.requests),
                  },
                ]
              : [],
          ),
    partial: heatRows.length > maxHeatmapCells || nativeRows.length > maxSummaryNativeHours,
  };
}
