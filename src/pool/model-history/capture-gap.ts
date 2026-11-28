import { homeSource, historyWriteReadiness } from "./capture-hours-mark.ts";
import { captureSettledAfter, captureSettleHorizon } from "./capture-hours-schema.ts";
import type { HistoryDatabase } from "./schema.ts";

/** The most Home rows past capture's cursor the read counts; more reads as this many and one. */
export const historyGapBehindCap = 10_000;

/** The window of the two seven-day counts, in hours before the settle horizon. */
const windowHours = 168;

/**
 * How far history is from Home, in counts only: Home usage rows past capture's forward cursor (up
 * to the cap and one), and over the seven days before the settle horizon the Home rows of ready
 * pools' users with no history row and the pool-hours with no settled count yet. The last two come
 * from the stored capture-hour counts, so they are as fresh as those: an hour a history write fills
 * is pending until it is counted again. One statement, no ids in or out.
 *
 * The rows past the cursor are read in id order through Home's primary key, as capture's own page
 * is, so the read stops at the cap. The counts are one range of the counts' key per ready pool,
 * whatever the table holds outside the window.
 */
const gapRead = (counted: boolean) => `WITH c AS (
    SELECT forward_id FROM basalt_model_history_cursor WHERE source = $1
  ), w AS (SELECT ${captureSettleHorizon} AS horizon)${
    counted
      ? `, k AS (
    SELECT n.settled, n.uncaptured FROM basalt_model_usage_people_ready r, w
    CROSS JOIN LATERAL (
      SELECT count(*) AS settled, coalesce(sum(s.uncaptured_requests), 0) AS uncaptured
      FROM basalt_model_capture_hours s
      WHERE s.pool = r.pool AND s.hour >= w.horizon - interval '${windowHours} hours'
        AND s.hour < w.horizon AND ${captureSettledAfter("s")}
    ) n
  )`
      : ""
  }
  SELECT
    (SELECT count(*) FROM (
      SELECT 1 FROM usage u, c WHERE u.id > c.forward_id ORDER BY u.id LIMIT ${historyGapBehindCap + 1}
    ) x)::int AS behind,
    ${
      counted
        ? `(SELECT coalesce(sum(uncaptured), 0) FROM k)::bigint AS uncaptured,
    (SELECT coalesce(sum(${windowHours} - settled), 0) FROM k)::int AS uncounted`
        : "NULL::bigint AS uncaptured, NULL::int AS uncounted"
    },
    EXISTS (SELECT 1 FROM c) AS active`;

export interface HistoryGap {
  readonly behind: number;
  readonly uncaptured7d: number | null;
  readonly uncountedHours7d: number | null;
}

/** The gap in one short read-only transaction; undefined while capture is not active. */
export async function readHistoryGap(db: HistoryDatabase): Promise<HistoryGap | undefined> {
  const source = await homeSource();
  await db.query("BEGIN TRANSACTION READ ONLY");
  try {
    await db.query("SELECT set_config('statement_timeout','2000ms',true)");
    const { captureHours } = await historyWriteReadiness(db);
    const row = (await db.query(gapRead(captureHours), [source])).rows[0];
    await db.query("COMMIT");
    if (row?.active !== true) return undefined;
    const count = (value: unknown) =>
      value === null || value === undefined ? null : Number(value);
    return {
      behind: Number(row.behind),
      uncaptured7d: count(row.uncaptured),
      uncountedHours7d: count(row.uncounted),
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * One line a pass, counts only. The counts cover Home's own rows: once `uncaptured7d` and
 * `uncountedHours7d` are both 0 and `behind` stays below a page, history holds them, a self-import
 * of Home rows included. Rows of another source, such as another system's imported records, are
 * neither counted nor marked here; such an import shows it is complete through its own completion
 * record.
 */
export async function logHistoryGap(db: HistoryDatabase) {
  const gap = await readHistoryGap(db);
  if (gap) console.info("POOL_MODEL_HISTORY_GAP", gap);
  return gap;
}
