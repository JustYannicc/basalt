import type { SeriesAuthority } from "./series-contract.ts";
import type { HistoryDatabase } from "./schema.ts";
import type { summarySelection } from "./summary-query.ts";
import { summaryCoverageQuery } from "./summary-query.ts";
import { requestCount, seriesCoverageRows } from "./series-coverage.ts";
import { timestamp } from "./record.ts";

export async function summaryCoverage(
  db: HistoryDatabase,
  selection: Awaited<ReturnType<typeof summarySelection>>,
  authority: SeriesAuthority,
) {
  const query = summaryCoverageQuery(selection);
  const rows = (await db.query(query.text, query.values)).rows;
  if (rows.length > 500) throw new Error("Usage source coverage exceeds its bound");
  const cursor = (
    await db.query(
      `SELECT c.forward_id::text,c.backfill_complete,c.sweep_id::text,c.sweep_upper::text,
        to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
        r.timestamp_exact AS captured_through
      FROM basalt_model_history_cursor c LEFT JOIN LATERAL (
        SELECT timestamp_exact FROM basalt_model_requests
        WHERE source=c.source AND c.forward_id<>0 AND source_record=
          encode(sha256(convert_to('["usage","'||c.forward_id::text||'"]','UTF8')),'hex')
        LIMIT 1
      ) r ON true WHERE c.source=$1`,
      [selection.homeSource],
    )
  ).rows[0];
  const capturedThrough =
    typeof cursor?.captured_through === "string" ? timestamp(cursor.captured_through) : null;
  const result = seriesCoverageRows(rows, cursor, capturedThrough, selection, authority);
  const native = rows.find((row) => row.source === selection.homeSource);
  return {
    ...result,
    nativeMappingProven:
      authority.mappingProven &&
      (native === undefined ||
        (requestCount(native.unmapped) === 0 && requestCount(native.other) === 0)),
  };
}
