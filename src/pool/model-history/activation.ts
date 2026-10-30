import { digest } from "../backend-users.ts";
import { counter, invalidHistory } from "./record.ts";
import { homePrivacyReady, requireHomePrivacyReady } from "./privacy.ts";
import { homeHistorySource } from "./home.ts";
import type { HistoryDatabase } from "./schema.ts";

export interface BackfillPlan {
  source: string;
  upperId: string;
  rows: string;
  privacyReady: boolean;
  firstAt: string | null;
  lastAt: string | null;
}

/** Counts only. No payloads, identities, keys, labels or prices are read for the dry run. */
export async function planHomeBackfill(db: HistoryDatabase): Promise<BackfillPlan> {
  await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    const result = await db.query(`SELECT COALESCE(MAX(id),0)::text AS upper_id, COUNT(*)::text AS rows,
      to_char(MIN(timestamp) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_at,
      to_char(MAX(timestamp) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_at FROM usage`);
    const row = result.rows[0];
    const upperId = counter(row?.upper_id), rows = counter(row?.rows);
    if (upperId === null || rows === null) return invalidHistory();
    const privacyReady = await homePrivacyReady(db);
    await db.query("COMMIT");
    return { privacyReady, source: await digest(homeHistorySource), upperId, rows,
      firstAt: typeof row?.first_at === "string" ? row.first_at : null,
      lastAt: typeof row?.last_at === "string" ? row.last_at : null };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** An explicitly approved snapshot starts the historical cursor at zero. Repeat activation is inert. */
export async function activateHomeBackfill(db: HistoryDatabase, plan: BackfillPlan): Promise<void> {
  const source = await digest(homeHistorySource);
  if (plan.privacyReady !== true || plan.source !== source || counter(plan.upperId) === null || counter(plan.rows) === null) return invalidHistory();
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL lock_timeout = '500ms'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    await requireHomePrivacyReady(db);
    const actual = await db.query("SELECT COUNT(*)::text AS rows FROM usage WHERE id <= $1::bigint", [plan.upperId]);
    if (actual.rows[0]?.rows !== plan.rows) throw new Error("Home history changed; make a new dry-run report");
    await db.query(`INSERT INTO basalt_model_history_cursor (source,forward_id,backfill_upper,backfill_id,sweep_id)
      VALUES ($1,$2,$2,0,0) ON CONFLICT (source) DO NOTHING`, [source, plan.upperId]);
    const saved = await db.query("SELECT backfill_upper::text AS upper_id FROM basalt_model_history_cursor WHERE source=$1", [source]);
    if (saved.rows[0]?.upper_id !== plan.upperId) throw new Error("A different Home backfill is already active");
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
