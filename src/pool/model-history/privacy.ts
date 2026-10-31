import type { HistoryDatabase } from "./schema.ts";

/** Match Home's own history-ready gate before freezing attribution in immutable rows. */
export async function homePrivacyReady(db: HistoryDatabase): Promise<boolean> {
  const result = await db.query(`SELECT EXISTS (SELECT 1 FROM home_data_migration
      WHERE name LIKE 'diagnostics_metadata_only_%')
    AND NOT EXISTS (SELECT 1 FROM home_data_migration
      WHERE name LIKE 'diagnostics_metadata_only_%' AND NOT completed) AS ready`);
  return result.rows[0]?.ready === true;
}

export async function requireHomePrivacyReady(db: HistoryDatabase): Promise<void> {
  if (!await homePrivacyReady(db)) throw new Error("Home privacy migration must finish before model history capture");
}
