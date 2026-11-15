import { appAttributionReady, type HistoryDatabase } from "./schema.ts";
import type { ModelRequest } from "./record.ts";
import { HistoryConflict, historyRecordLayout, recordValues } from "./store.ts";

export const historyBulkBatchSize = 5000;

/** The caller owns the transaction and must roll it back on any refusal. Counts use unique IDs. */
export async function insertBulkRequests(db: HistoryDatabase, records: readonly ModelRequest[]) {
  if (records.length > historyBulkBatchSize)
    throw new Error("Model usage bulk batch exceeds its limit");
  if (!records.length) return { inserted: 0, existing: 0, count: 0 };
  const appAttribution = await appAttributionReady(db);
  if (!appAttribution && records.some((row) => row.appId != null || row.requirement != null))
    throw new HistoryConflict();
  const byId = new Map<string, ReturnType<typeof recordValues>>();
  for (const row of records) {
    const value = recordValues(row, appAttribution);
    const previous = byId.get(row.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new HistoryConflict();
    byId.set(row.id, value);
  }
  const values = [...byId.values()];
  const { selected, types, names } = historyRecordLayout(appAttribution);
  const json = JSON.stringify(values);
  const existing = async () => {
    // Per-ID lookups preserve partition pruning; full equality also checks source and ownership.
    const result = await db.query(
      `SELECT saved.id, ROW(${names.map((name) => `saved.${name}`).join(",")})
        IS DISTINCT FROM ROW(${names.map((name) => `incoming.${name}`).join(",")}) AS conflict
      FROM jsonb_to_recordset($1::jsonb) AS incoming(${types})
      CROSS JOIN LATERAL (SELECT ${selected} FROM basalt_model_requests
        WHERE id=incoming.id LIMIT 1) AS saved`,
      [json],
    );
    if (result.rows.some((row) => row.conflict === true)) throw new HistoryConflict();
    return new Set(result.rows.map((row) => String(row.id)));
  };
  const retained = await existing();
  const missing = values.filter((row) => !retained.has(row.id));
  if (!missing.length) return { inserted: 0, existing: values.length, count: values.length };
  const result = await db.query(
    `INSERT INTO basalt_model_requests (${selected})
    SELECT ${selected} FROM jsonb_to_recordset($1::jsonb) AS incoming(${types})
    ORDER BY id ON CONFLICT (id) DO NOTHING RETURNING id`,
    [JSON.stringify(missing)],
  );
  // ON CONFLICT can wait for another transaction, whose contents the first check could not see.
  await existing();
  const inserted = result.rowCount ?? result.rows.length;
  return { inserted, existing: values.length - inserted, count: values.length };
}
