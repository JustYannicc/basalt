import type { HistoryDatabase } from "./schema.ts";
import type { seriesGrouping } from "./series-grouping.ts";
import { utcSql } from "./series-query.ts";
import { rollupAggregates, rollupRowsText, rollupWindow } from "./summary-rollup-query.ts";
import { usageRollupTargets } from "./usage-rollup-targets.ts";

/**
 * True when the pool is ready on the v16 rollup, the one rollup keyed by every series dimension.
 * Until then, and before v16's tables exist, the series reads raw rows exactly as before.
 */
export async function seriesRollupReady(db: HistoryDatabase, pool: unknown) {
  const { ready } = usageRollupTargets.v16;
  const tables = await db.query(`SELECT to_regclass('${ready}') IS NOT NULL AS present`);
  if (tables.rows[0]?.present !== true) return false;
  return (await db.query(`SELECT 1 FROM ${ready} WHERE pool=$1`, [pool])).rows.length === 1;
}

/**
 * The series range as v16 groups: whole hours from the rollup, and the hours the bounds cut
 * aggregated from their raw rows cut at the bounds. Both time zones the series allows are whole
 * hours from UTC, so every local hour and day bucket is a union of whole UTC hours.
 */
export function seriesRollupRows(from: string, to: string) {
  return rollupRowsText(rollupWindow(from, to, []), "v16");
}

/** The raw path's grouping and buckets over groups; each aggregate sums the groups' counts. */
export function seriesRollupAggregate(
  rows: string,
  grouping: ReturnType<typeof seriesGrouping>,
  bucket: "hour" | "day",
  timezone: string,
  priced: boolean,
) {
  return `normalized AS (SELECT *, ${grouping.projection},
      date_trunc('${bucket}', hour AT TIME ZONE '${timezone}') AS bucket_local FROM ${rows} OFFSET 0),
    aggregated AS (SELECT ${grouping.columns}, bucket_local, ${rollupAggregates(priced).join(",\n      ")}
      FROM normalized GROUP BY ${grouping.columns},bucket_local)`;
}

const count = (filter?: string) =>
  `coalesce(sum(requests)${filter ? ` FILTER (WHERE ${filter})` : ""},0)::text`;

/** The raw coverage statement's per-source figures, as sums of group counts. */
export const seriesRollupCoverage =
  () => `SELECT source,min(first_at) AS first_at,max(last_at) AS last_at,
      ${utcSql("max(ingested_at)")} AS ingested_at, ${count()} AS requests,
      ${count("saved_account NOT IN ('unmapped','otherAccounts') AND saved_account NOT LIKE 'imported:%'")} AS mapped,
      ${count("saved_account = 'unmapped' OR saved_account LIKE 'imported:%'")} AS unmapped,
      ${count("counts_only AND saved_account = 'otherAccounts'")} AS other,
      ${count("NOT counts_only AND cost_basis = 'home-charge'")} AS home_priced,
      ${count("NOT counts_only AND cost_basis = 'historical-api-price' AND currency = 'USD'")} AS imported_priced,
      ${count("NOT counts_only AND cost_basis = 'unpriced'")} AS unpriced,
      ${count("counts_only OR cost_basis = 'historical-api-price' AND currency <> 'USD'")} AS missing,
      ${count("NOT counts_only AND cost_basis <> 'unpriced' AND NOT has_snapshot")} AS missing_snapshot,
      ${count("NOT counts_only AND cost_basis <> 'unpriced' AND NOT has_version")} AS missing_version
      FROM selected GROUP BY source ORDER BY source LIMIT 501`;
