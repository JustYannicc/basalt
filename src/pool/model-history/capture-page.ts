import { markWrittenHours } from "./capture-hours-mark.ts";
import { homeHistorySelect, homeRequest } from "./home.ts";
import { counter, invalidHistory } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import {
  HistoryConflict,
  existingRequests,
  historyBatchSize,
  historyRecordLayout,
  recordValues,
} from "./store.ts";

export interface ForwardPage {
  /** Home rows read; fewer than a page means capture reached the end of Home. */
  rows: number;
  inserted: number;
  /** The cursor after this page, or null when the page was empty. */
  through: string | null;
}

/**
 * This transaction's limits, as today's capture sets them. Their own statement, before the read: a
 * limit set inside a statement covers only the statements after it, so a page read that set its
 * own could wait behind a lock on a Home table with no limit at all. Each is local to the
 * transaction, which is what Hyperdrive pools by.
 */
const pageLimits = `SELECT set_config('lock_timeout','500ms',true),
  set_config('statement_timeout','5s',true)`;

/** The page with the cursor lock; a second capture fails after the 500 ms lock limit. */
const pageRead = `WITH cursor AS MATERIALIZED (
    SELECT forward_id FROM basalt_model_history_cursor WHERE source=$1 FOR UPDATE
  ) ${homeHistorySelect}
  WHERE u.id > (SELECT forward_id FROM cursor)
  ORDER BY u.id LIMIT $2`;

/**
 * Today's ownership rule in one statement: a saved request with the same id must have the same
 * source and source record, and keeps its original pool. A conflict writes nothing, the cursor
 * included. `saved` counts the incoming ids already retained, so the caller knows whether
 * ON CONFLICT skipped a row this statement's snapshot could not see.
 */
const pageWrite = (
  selected: string,
  types: string,
  captureHours: boolean,
) => `WITH incoming AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS incoming(${types})
  ), saved AS MATERIALIZED (
    SELECT incoming.id, saved.source IS DISTINCT FROM incoming.source
      OR saved.source_record IS DISTINCT FROM incoming.source_record AS differs
    FROM incoming CROSS JOIN LATERAL (SELECT source,source_record FROM basalt_model_requests
      WHERE id=incoming.id LIMIT 1) AS saved
  ), inserted AS (
    INSERT INTO basalt_model_requests (${selected})
    SELECT ${selected} FROM incoming WHERE NOT EXISTS (SELECT 1 FROM saved WHERE differs)
    ON CONFLICT (id) DO NOTHING RETURNING id, pool, timestamp, source
  ),${captureHours ? ` ${markWrittenHours("inserted", "$2")},` : ""} moved AS (
    UPDATE basalt_model_history_cursor SET forward_id=$3::bigint,updated_at=CURRENT_TIMESTAMP
    WHERE source=$2 AND NOT EXISTS (SELECT 1 FROM saved WHERE differs) RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM saved WHERE differs) AS conflict,
    (SELECT count(*) FROM saved)::int AS saved, (SELECT count(*) FROM inserted)::int AS inserted,
    (SELECT count(*) FROM moved)::int AS moved`;

/**
 * One forward page, committed with the cursor, in five round trips: BEGIN, the limits, the locked
 * read, the write, COMMIT. A session cut between pages keeps every page it committed. Only a
 * forward commit moves the capture time, an empty page's included, so a capture that keeps failing
 * its pages goes stale.
 */
export async function captureForwardPage(
  db: HistoryDatabase,
  source: string,
  { appAttribution, captureHours }: { appAttribution: boolean; captureHours: boolean },
): Promise<ForwardPage> {
  await db.query("BEGIN");
  try {
    await db.query(pageLimits);
    const rows = (await db.query(pageRead, [source, historyBatchSize])).rows;
    if (!rows.length) {
      await db.query(
        "UPDATE basalt_model_history_cursor SET updated_at=CURRENT_TIMESTAMP WHERE source=$1",
        [source],
      );
      await db.query("COMMIT");
      return { rows: 0, inserted: 0, through: null };
    }
    const records = await Promise.all(rows.map((row) => homeRequest(row, source)));
    if (!appAttribution && records.some((row) => row.appId != null || row.requirement != null))
      throw new Error("App model attribution migration is not ready");
    const through = counter(rows.at(-1)!.source_id) ?? invalidHistory();
    const { selected, types } = historyRecordLayout(appAttribution);
    const written = (
      await db.query(pageWrite(selected, types, captureHours), [
        JSON.stringify(records.map((row) => recordValues(row, appAttribution))),
        source,
        through,
      ])
    ).rows[0];
    if (written?.conflict === true) throw new HistoryConflict();
    if (written?.moved !== 1) return invalidHistory();
    const inserted = Number(written.inserted);
    // ON CONFLICT waited for a writer this snapshot could not see and skipped its row: check that
    // row's ownership as the second lookup always did, before the page commits.
    if (inserted + Number(written.saved) < records.length)
      await existingRequests(db, records, true);
    await db.query("COMMIT");
    return { rows: rows.length, inserted, through };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
