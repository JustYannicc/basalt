import { digest } from "../backend-users.ts";
import { requireHomePrivacyReady } from "./privacy.ts";
import { counter, invalidHistory } from "./record.ts";
import { homeHistorySelect, homeHistorySource, homeRequest } from "./home.ts";
import { appAttributionReady, type HistoryDatabase } from "./schema.ts";
import { historyBatchSize, insertRequests } from "./store.ts";
import { pendingPoolHistoryChanges, poolHistoryPendingProjection } from "./change-revisions.ts";
import { projectPoolHistoryChanges } from "./change-projection.ts";
import { captureForwardPage } from "./capture-page.ts";

export interface CaptureOptions {
  /**
   * Asked before each forward page with the pages this session already took; true ends the session
   * there (its time is up, a handover).
   */
  stop?: (pages: number) => boolean;
}

/**
 * One capture session. The backfill and the late-commit sweep commit with their cursor fields
 * first; then each forward page commits with the forward cursor on its own, so a session cut
 * between pages keeps every page it finished. Home owns its existing usage writes.
 */
export async function captureHomeRequests(db: HistoryDatabase, options: CaptureOptions = {}) {
  const source = await digest(homeHistorySource);
  await db.query("BEGIN");
  let inserted = 0,
    swept = 0,
    backfilled = 0,
    old: string,
    complete: boolean,
    forward: string,
    appAttribution: boolean,
    journalReady: boolean,
    unprojected: boolean,
    pending: ReturnType<typeof pendingPoolHistoryChanges>;
  try {
    await db.query("SET LOCAL lock_timeout = '500ms'");
    // New capture code can run before the operator applies the additive change tables.
    const readiness = await db.query(`SELECT set_config('statement_timeout','5s',true),
      to_regclass('basalt_pool_change_pending') IS NOT NULL AS pending_ready,
      to_regprocedure('basalt_pool_change_revision(text,text)') IS NOT NULL AS journal_ready`);
    journalReady = readiness.rows[0]?.journal_ready === true;
    const pendingProjection =
      readiness.rows[0]?.pending_ready === true ? poolHistoryPendingProjection : "'[]'::jsonb";
    const result = await db.query(
      `SELECT cursor.*,${pendingProjection} AS pending,
        ${journalReady ? "EXISTS(SELECT 1 FROM basalt_pool_change_batches)" : "false"} AS unprojected
      FROM (SELECT 1) AS upkeep LEFT JOIN LATERAL (
        SELECT source,forward_id::text,backfill_upper::text,backfill_id::text,backfill_complete,sweep_id::text,sweep_upper::text
        FROM basalt_model_history_cursor WHERE source = $1 FOR UPDATE
      ) AS cursor ON true`,
      [source],
    );
    const state = result.rows[0];
    pending = pendingPoolHistoryChanges(state?.pending);
    unprojected = state?.unprojected === true;
    // Deployment cannot opt a database into collection. The operator first approves its
    // count-only dry run and creates this cursor through the activation command.
    if (!state?.source) {
      await db.query("COMMIT");
      pending = await project(db, journalReady, unprojected, pending);
      return { state: "inactive" as const, pending };
    }
    await requireHomePrivacyReady(db);
    appAttribution = await appAttributionReady(db);
    const next = counter(state.forward_id),
      sweep = counter(state.sweep_id),
      savedSweepUpper = counter(state.sweep_upper);
    const upper = counter(state.backfill_upper),
      backfill = counter(state.backfill_id);
    if (
      upper === null ||
      backfill === null ||
      next === null ||
      sweep === null ||
      savedSweepUpper === null
    )
      return invalidHistory();
    forward = next;
    old = backfill;
    complete = state.backfill_complete === true;
    let seen = sweep;
    for (let page = 0; page < 2 && !complete; page++) {
      const rows = (
        await db.query(
          `${homeHistorySelect} WHERE u.id > $1::bigint AND u.id <= $2::bigint
        ORDER BY u.id LIMIT $3`,
          [old, upper, historyBatchSize],
        )
      ).rows;
      inserted += await insertRequests(
        db,
        await Promise.all(rows.map((row) => homeRequest(row, source))),
        true,
      );
      backfilled += rows.length;
      if (rows.length) old = counter(rows.at(-1)!.source_id)!;
      complete = rows.length < historyBatchSize || old === upper;
    }
    // Sequence allocation can precede commit. A bounded repeat sweep catches a lower id that
    // commits after the forward cursor passed it, however long that transaction took.
    let sweepUpper = savedSweepUpper === "0" ? forward : savedSweepUpper;
    const late = (
      await db.query(
        `${homeHistorySelect} WHERE u.id > $1::bigint AND u.id <= $2::bigint
      ORDER BY u.id LIMIT $3`,
        [seen, sweepUpper, historyBatchSize],
      )
    ).rows;
    // A key may have moved since an uncharged row was captured. Keep the original attribution;
    // re-reading Home's current key owner must neither rewrite the row nor stall capture.
    inserted += await insertRequests(
      db,
      await Promise.all(late.map((row) => homeRequest(row, source))),
      true,
    );
    swept = late.length;
    seen = late.length ? counter(late.at(-1)!.source_id)! : seen;
    if (late.length < historyBatchSize || BigInt(seen) >= BigInt(sweepUpper)) {
      seen = "0";
      sweepUpper = "0";
    }
    // The forward cursor and the capture time are the pages' own; this moves the backfill and sweep.
    await db.query(
      `UPDATE basalt_model_history_cursor SET sweep_id=$2,backfill_id=$3,
      backfill_complete=$4,sweep_upper=$5 WHERE source=$1`,
      [source, seen, old, complete, sweepUpper],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
  let pages = 0,
    fresh = 0,
    caughtUp = false;
  while (!options.stop?.(pages)) {
    const page = await captureForwardPage(db, source, appAttribution);
    pages++;
    fresh += page.rows;
    inserted += page.inserted;
    if (page.through !== null) forward = page.through;
    if (page.rows < historyBatchSize) {
      caughtUp = true;
      break;
    }
  }
  pending = await project(db, journalReady, unprojected || inserted > 0, pending);
  return {
    state: "active" as const,
    scanned: fresh + backfilled + swept,
    inserted,
    pages,
    fresh,
    swept,
    caughtUp,
    through: forward,
    backfillThrough: old,
    backfillComplete: complete,
    pending,
  };
}

/** Called after capture commits, never in the transaction that produced the changes. */
async function project(
  db: HistoryDatabase,
  journalReady: boolean,
  due: boolean,
  pending: ReturnType<typeof pendingPoolHistoryChanges>,
) {
  if (!journalReady || !due) return pending;
  try {
    await projectPoolHistoryChanges(db);
    const result = await db.query(`SELECT ${poolHistoryPendingProjection} AS pending`);
    return pendingPoolHistoryChanges(result.rows[0]?.pending);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
