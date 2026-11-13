import { digest } from "../backend-users.ts";
import type { HistoryDatabase } from "./schema.ts";
import { timestamp } from "./record.ts";
import {
  apiEquivalentUnavailable,
  outsideSeries,
  type PoolUsageSeriesInput,
  type SeriesCoverage,
  type SeriesAuthority,
} from "./series-contract.ts";
import type { seriesQuery } from "./series-query.ts";

/** Counts have bounded JSON numbers; token and money values never use this conversion. */
export function requestCount(value: unknown): number {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new Error("Invalid usage count");
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error("Usage count exceeds the response range");
  return count;
}
const nullableAt = (value: unknown) =>
  value === null || value === undefined ? null : timestamp(String(value));

export async function seriesCoverage(
  db: HistoryDatabase,
  query: Awaited<ReturnType<typeof seriesQuery>>,
  input: PoolUsageSeriesInput,
  authority: SeriesAuthority,
  personal = false,
) {
  const result = await db.query(query.coverageText, query.coverageValues);
  if (result.rows.length > 500) throw new Error("Usage source coverage exceeds its bound");
  const cursor =
    personal || input.sources?.includes(query.homeSource) === false
      ? undefined
      : (
          await db.query(
            `SELECT forward_id::text,backfill_complete,sweep_id::text,sweep_upper::text,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
      FROM basalt_model_history_cursor WHERE source=$1`,
            [query.homeSource],
          )
        ).rows[0];
  let capturedThrough: string | null = null;
  if (cursor && cursor.forward_id !== "0") {
    const sourceRecord = await digest(JSON.stringify(["usage", String(cursor.forward_id)]));
    capturedThrough = nullableAt(
      (
        await db.query(
          "SELECT timestamp_exact FROM basalt_model_requests WHERE source=$1 AND source_record=$2 LIMIT 1",
          [query.homeSource, sourceRecord],
        )
      ).rows[0]?.timestamp_exact,
    );
  }
  const rows = result.rows;
  const sum = (key: string) => {
    const total = rows.reduce((total, row) => total + requestCount(row[key]), 0);
    if (!Number.isSafeInteger(total))
      throw new Error("Usage coverage count exceeds the response range");
    return total;
  };
  const first = rows
    .map((row) => nullableAt(row.first_at))
    .filter((at): at is string => at !== null)
    .sort();
  const last = rows
    .map((row) => nullableAt(row.last_at))
    .filter((at): at is string => at !== null)
    .sort();
  const watermarks = [
    nullableAt(cursor?.updated_at),
    ...rows.map((row) => nullableAt(row.ingested_at)),
  ]
    .filter((at): at is string => at !== null)
    .sort();
  const sources: SeriesCoverage["sources"] = rows.map((row) => ({
    source: String(row.source),
    kind:
      row.source === query.homeSource
        ? "home"
        : row.source === query.gatewaySource
          ? "gateway"
          : "import",
    firstAt: nullableAt(row.first_at),
    lastAt: nullableAt(row.last_at),
    backfillComplete:
      row.source === query.homeSource && cursor ? cursor.backfill_complete === true : null,
    sweep:
      row.source === query.homeSource && cursor
        ? { id: String(cursor.sweep_id), upper: String(cursor.sweep_upper) }
        : null,
  }));
  if (cursor && !sources.some((entry) => entry.source === query.homeSource))
    sources.push({
      source: query.homeSource,
      kind: "home",
      firstAt: null,
      lastAt: null,
      backfillComplete: cursor.backfill_complete === true,
      sweep: { id: String(cursor.sweep_id), upper: String(cursor.sweep_upper) },
    });
  const coverage: SeriesCoverage = {
    sources: sources.sort((a, b) => a.source.localeCompare(b.source)),
    firstAt: first[0] ?? null,
    lastAt: last.at(-1) ?? null,
    capturedThrough,
    mapping: {
      current: true,
      historicalGenerations: "unknown",
      proof: authority.mappingProven ? "proven" : "unavailable",
      mapped: sum("mapped"),
      unmapped: sum("unmapped"),
      otherAccounts: sum("other"),
    },
    pricing: {
      homeCharge: sum("home_priced"),
      importedApiPrice: sum("imported_priced"),
      unpriced: sum("unpriced"),
      missing: sum("missing"),
      missingSnapshot: sum("missing_snapshot"),
      missingVersion: sum("missing_version"),
      apiEquivalent: apiEquivalentUnavailable,
    },
    priceProjection: outsideSeries,
    percentiles: outsideSeries,
    seasonalTrainingRange: outsideSeries,
  };
  let homeThrough = capturedThrough;
  if (input.forecast && cursor?.backfill_complete === true) {
    const native = (await db.query("SELECT to_regclass('usage') AS relation")).rows[0];
    if (native?.relation) {
      const head = (await db.query("SELECT id::text FROM usage ORDER BY id DESC LIMIT 1")).rows[0];
      // A fresh empty read proves idle days too. The last request time alone cannot do that.
      if (!head || BigInt(String(head.id)) <= BigInt(String(cursor.forward_id)))
        homeThrough = nullableAt(cursor.updated_at);
    }
  }
  return { coverage, asOf: watermarks.at(-1) ?? null, homeThrough };
}
