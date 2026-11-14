import { historyImportCompletionVersion } from "./import-completion-schema.ts";
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
  const ready =
    !personal &&
    (
      await db.query("SELECT 1 FROM basalt_model_history_migrations WHERE name=$1", [
        historyImportCompletionVersion,
      ])
    ).rows.length > 0;
  return seriesCoverageFromSnapshot(
    db,
    {
      pool: query.coverageValues[0],
      rows: result.rows,
      cursor,
      capturedThrough,
      completionReady: ready,
    },
    query,
    authority,
  );
}

/** Completion reads and projection share the canonical migration gate and the caller's snapshot. */
export async function seriesCoverageFromSnapshot(
  db: HistoryDatabase,
  snapshot: {
    pool: unknown;
    rows: readonly Record<string, unknown>[];
    cursor: Record<string, unknown> | undefined;
    capturedThrough: string | null;
    completionReady: boolean;
  },
  query: { homeSource: string; gatewaySource: string },
  authority: SeriesAuthority,
) {
  const completions = snapshot.completionReady
    ? (
        await db.query(
          `SELECT source,frozen_from AS "frozenFrom",frozen_to AS "frozenTo",
    upper_source_id::text AS "upperSourceId",manifest_digest AS "manifestDigest",map_digest AS "accountMappingDigest",
    ids_digest AS "idsDigest",verified_rows::text AS "verifiedRows" FROM basalt_model_import_completion
    WHERE pool=$1 AND source=ANY($2::text[])`,
          [snapshot.pool, snapshot.rows.map((row) => row.source)],
        )
      ).rows
    : [];
  const completionBySource = new Map(
    completions.map((row) => [
      String(row.source),
      {
        frozenFrom: String(row.frozenFrom),
        frozenTo: String(row.frozenTo),
        upperSourceId: String(row.upperSourceId),
        manifestDigest: String(row.manifestDigest),
        accountMappingDigest: String(row.accountMappingDigest),
        idsDigest: String(row.idsDigest),
        verifiedRows: String(row.verifiedRows),
      },
    ]),
  );
  const { rows, cursor, capturedThrough } = snapshot;
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
      row.source === query.homeSource && cursor
        ? cursor.backfill_complete === true
        : row.source !== query.homeSource && row.source !== query.gatewaySource
          ? completionBySource.has(String(row.source))
          : null,
    ...(completionBySource.has(String(row.source))
      ? { completion: completionBySource.get(String(row.source))! }
      : {}),
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
  return { coverage, asOf: watermarks.at(-1) ?? null };
}
