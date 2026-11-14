import { historyImportCompletionVersion } from "./import-completion-schema.ts";
import type { SeriesAuthority } from "./series-contract.ts";
import { historyTerminalIntegrityVersion, type HistoryDatabase } from "./schema.ts";
import type { summarySelection } from "./summary-query.ts";
import { summaryCoverageQuery } from "./summary-query.ts";
import { requestCount, seriesCoverageFromSnapshot } from "./series-coverage.ts";
import { timestamp } from "./record.ts";

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
        EXISTS(SELECT 1 FROM basalt_model_history_migrations WHERE name=$2) AS completion_ready,
        (to_regclass('basalt_model_terminal_starts') IS NOT NULL
          AND to_regclass('basalt_model_terminal_finishes') IS NOT NULL
          AND EXISTS(SELECT 1 FROM basalt_model_history_migrations WHERE name=$3)) AS terminal_ready
      FROM (SELECT 1) checkpoint
      LEFT JOIN basalt_model_history_cursor c ON c.source=$1 LEFT JOIN LATERAL (
        SELECT timestamp_exact FROM basalt_model_requests
        WHERE source=c.source AND c.forward_id<>0 AND source_record=
          encode(sha256(convert_to('["usage","'||c.forward_id::text||'"]','UTF8')),'hex')
        LIMIT 1
      ) r ON true`,
      [selection.homeSource, historyImportCompletionVersion, historyTerminalIntegrityVersion],
    )
  ).rows[0];
  const cursor = typeof state?.forward_id === "string" ? state : undefined;
  const capturedThrough =
    typeof cursor?.captured_through === "string" ? timestamp(cursor.captured_through) : null;
  const result = await seriesCoverageFromSnapshot(
    db,
    {
      pool: selection.values[0],
      rows,
      cursor,
      capturedThrough,
      completionReady: state?.completion_ready === true,
    },
    selection,
    authority,
  );
  const native = rows.find((row) => row.source === selection.homeSource);
  return {
    ...result,
    terminalReady: state?.terminal_ready === true,
    nativeMappingProven:
      authority.mappingProven &&
      (native === undefined ||
        (requestCount(native.unmapped) === 0 && requestCount(native.other) === 0)),
  };
}
