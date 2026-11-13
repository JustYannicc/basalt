import { digest } from "../backend-users.ts";
import { requireHomePrivacyReady } from "./privacy.ts";
import { counter, invalidHistory } from "./record.ts";
import { homeHistorySelect, homeHistorySource, homeRequest } from "./home.ts";
import type { HistoryDatabase } from "./schema.ts";
import { historyBatchSize, insertRequests } from "./store.ts";

/** Source reads, inserts and cursor changes commit together. Home owns its existing usage writes. */
export async function captureHomeRequests(db: HistoryDatabase) {
  const source = await digest(homeHistorySource);
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL lock_timeout = '500ms'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    const result = await db.query(`SELECT forward_id::text,backfill_upper::text,backfill_id::text,backfill_complete,sweep_id::text,sweep_upper::text
      FROM basalt_model_history_cursor WHERE source = $1 FOR UPDATE`, [source]);
    const state = result.rows[0];
    // Deployment cannot opt a database into collection. The operator first approves its
    // count-only dry run and creates this cursor through the activation command.
    if (!state) { await db.query("COMMIT"); return { state: "inactive" as const }; }
    await requireHomePrivacyReady(db);
    const forward = counter(state.forward_id), sweep = counter(state.sweep_id), savedSweepUpper = counter(state.sweep_upper);
    const upper = counter(state.backfill_upper), backfill = counter(state.backfill_id);
    if (upper === null || backfill === null || forward === null || sweep === null || savedSweepUpper === null) return invalidHistory();
    let next = forward, seen = sweep, old = backfill, complete = state.backfill_complete === true, inserted = 0, scanned = 0;
    for (let page = 0; page < 2; page++) {
      const rows = (await db.query(`${homeHistorySelect} WHERE u.id > $1::bigint ORDER BY u.id LIMIT $2`, [next, historyBatchSize])).rows;
      inserted += await insertRequests(db, await Promise.all(rows.map((row) => homeRequest(row, source))), true);
      scanned += rows.length;
      if (rows.length) next = counter(rows.at(-1)!.source_id)!;
      if (rows.length < historyBatchSize) break;
    }
    for (let page = 0; page < 2 && !complete; page++) {
      const rows = (await db.query(`${homeHistorySelect} WHERE u.id > $1::bigint AND u.id <= $2::bigint
        ORDER BY u.id LIMIT $3`, [old, upper, historyBatchSize])).rows;
      inserted += await insertRequests(db, await Promise.all(rows.map((row) => homeRequest(row, source))), true);
      scanned += rows.length;
      if (rows.length) old = counter(rows.at(-1)!.source_id)!;
      complete = rows.length < historyBatchSize || old === upper;
    }
    // Sequence allocation can precede commit. A bounded repeat sweep catches a lower id that
    // commits after the forward cursor passed it, however long that transaction took.
    let sweepUpper = savedSweepUpper === "0" ? next : savedSweepUpper;
    const late = (await db.query(`${homeHistorySelect} WHERE u.id > $1::bigint AND u.id <= $2::bigint
      ORDER BY u.id LIMIT $3`, [seen, sweepUpper, historyBatchSize])).rows;
    // A key may have moved since an uncharged row was captured. Keep the original attribution;
    // re-reading Home's current key owner must neither rewrite the row nor stall capture.
    inserted += await insertRequests(db, await Promise.all(late.map((row) => homeRequest(row, source))), true);
    scanned += late.length;
    seen = late.length ? counter(late.at(-1)!.source_id)! : seen;
    if (late.length < historyBatchSize || BigInt(seen) >= BigInt(sweepUpper)) { seen = "0"; sweepUpper = "0"; }
    await db.query(`UPDATE basalt_model_history_cursor SET forward_id=$2,sweep_id=$3,backfill_id=$4,
      backfill_complete=$5,sweep_upper=$6,updated_at=CURRENT_TIMESTAMP WHERE source=$1`, [source, next, seen, old, complete, sweepUpper]);
    await db.query("COMMIT");
    return { state: "active" as const, scanned, inserted, through: next, backfillThrough: old, backfillComplete: complete };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
