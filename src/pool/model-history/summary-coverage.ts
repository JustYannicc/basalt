import type { SeriesAuthority } from "./series-contract.ts";
import type { HistoryDatabase } from "./schema.ts";
import type { summarySelection } from "./summary-query.ts";
import { summaryCoverageQuery } from "./summary-query.ts";
import { requestCount, seriesCoverageRows } from "./series-coverage.ts";
import { timestamp } from "./record.ts";

function completion(row: Record<string, unknown>) {
  const hashes = [row.source, row.manifestDigest, row.accountMappingDigest, row.idsDigest];
  if (
    hashes.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) ||
    typeof row.upperSourceId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(row.upperSourceId) ||
    typeof row.verifiedRows !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(row.verifiedRows)
  )
    return;
  try {
    const frozenFrom = timestamp(row.frozenFrom),
      frozenTo = timestamp(row.frozenTo);
    if (frozenFrom > frozenTo) return;
    return {
      source: String(row.source),
      value: {
        frozenFrom,
        frozenTo,
        upperSourceId: row.upperSourceId,
        manifestDigest: String(row.manifestDigest),
        accountMappingDigest: String(row.accountMappingDigest),
        idsDigest: String(row.idsDigest),
        verifiedRows: row.verifiedRows,
      },
    };
  } catch {
    return;
  }
}

export async function summaryCoverage(
  db: HistoryDatabase,
  selection: Awaited<ReturnType<typeof summarySelection>>,
  authority: SeriesAuthority,
) {
  const query = summaryCoverageQuery(selection);
  const rows = (await db.query(query.text, query.values)).rows;
  if (rows.length > 500) throw new Error("Usage source coverage exceeds its bound");
  const state = (
    await db.query(
      `SELECT c.forward_id::text,c.backfill_complete,c.sweep_id::text,c.sweep_upper::text,
        to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
        r.timestamp_exact AS captured_through,
        to_regclass('basalt_model_import_completion') IS NOT NULL AS completion_ready
      FROM (SELECT 1) checkpoint
      LEFT JOIN basalt_model_history_cursor c ON c.source=$1 LEFT JOIN LATERAL (
        SELECT timestamp_exact FROM basalt_model_requests
        WHERE source=c.source AND c.forward_id<>0 AND source_record=
          encode(sha256(convert_to('["usage","'||c.forward_id::text||'"]','UTF8')),'hex')
        LIMIT 1
      ) r ON true`,
      [selection.homeSource],
    )
  ).rows[0];
  const cursor = typeof state?.forward_id === "string" ? state : undefined;
  const capturedThrough =
    typeof cursor?.captured_through === "string" ? timestamp(cursor.captured_through) : null;
  const result = seriesCoverageRows(rows, cursor, capturedThrough, selection, authority);
  const imports = result.coverage.sources.filter((source) => source.kind === "import");
  const completed =
    state?.completion_ready === true && imports.length > 0
      ? (
          await db.query(
            `SELECT source,frozen_from AS "frozenFrom",frozen_to AS "frozenTo",
        upper_source_id::text AS "upperSourceId",manifest_digest AS "manifestDigest",
        map_digest AS "accountMappingDigest",ids_digest AS "idsDigest",verified_rows::text AS "verifiedRows"
      FROM basalt_model_import_completion WHERE pool=$1 AND source=ANY($2::text[]) LIMIT 501`,
            [selection.values[0], imports.map((source) => source.source)],
          )
        ).rows
      : [];
  if (completed.length > 500) throw new Error("Import completion coverage exceeds its bound");
  const bySource = new Map(
    completed.flatMap((row) => {
      const parsed = completion(row);
      return parsed ? [[parsed.source, parsed.value] as const] : [];
    }),
  );
  const native = rows.find((row) => row.source === selection.homeSource);
  return {
    ...result,
    coverage: {
      ...result.coverage,
      sources: result.coverage.sources.map((source) =>
        source.kind === "import"
          ? {
              ...source,
              backfillComplete: bySource.has(source.source),
              ...(bySource.has(source.source) ? { completion: bySource.get(source.source)! } : {}),
            }
          : source,
      ),
    },
    nativeMappingProven:
      authority.mappingProven &&
      (native === undefined ||
        (requestCount(native.unmapped) === 0 && requestCount(native.other) === 0)),
  };
}
