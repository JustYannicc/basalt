import type { HistoryDatabase } from "./schema.ts";

/** The probe also supports a reader deployed before the separately approved v9 schema apply. */
export async function historyJournalPrepared(db: HistoryDatabase) {
  const result = await db.query(
    "SELECT to_regprocedure('basalt_pool_change_revision(text,text)') IS NOT NULL AS ready",
  );
  return result.rows[0]?.ready === true;
}

/** Called after capture commits, never in the transaction that produced the changes. */
export async function projectPoolHistoryChanges(db: HistoryDatabase) {
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await db.query("SET LOCAL lock_timeout = '500ms'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    const result = await db.query("SELECT basalt_pool_project_changes(100) AS projected");
    const projected = result.rows[0]?.projected;
    if (
      typeof projected !== "number" ||
      !Number.isInteger(projected) ||
      projected < 0 ||
      projected > 100
    )
      throw new Error("Invalid pool change projection result");
    await db.query("COMMIT");
    return projected;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
