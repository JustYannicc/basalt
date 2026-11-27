import type { HistoryDatabase } from "./schema.ts";
import { historyWriteReadiness, homeSource, markWrittenHours } from "./capture-hours-mark.ts";
import type { ModelRequest } from "./record.ts";
import { HistoryConflict, historyRecordLayout, recordValues } from "./store.ts";

export const historyBulkBatchSize = 5000;

/** The caller owns the transaction and must roll it back on any refusal. Counts use unique IDs. */
export async function insertBulkRequests(db: HistoryDatabase, records: readonly ModelRequest[]) {
  if (records.length > historyBulkBatchSize)
    throw new Error("Model usage bulk batch exceeds its limit");
  if (!records.length) return { inserted: 0, existing: 0, count: 0 };
  const { appAttribution, captureHours } = await historyWriteReadiness(db);
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
  const existing = async (incoming: typeof values) => {
    // Per-ID lookups preserve partition pruning; full equality also checks source and ownership.
    const result = await db.query(
      `SELECT saved.id, ROW(${names.map((name) => `saved.${name}`).join(",")})
        IS DISTINCT FROM ROW(${names.map((name) => `incoming.${name}`).join(",")}) AS conflict
      FROM jsonb_to_recordset($1::jsonb) AS incoming(${types})
      CROSS JOIN LATERAL (SELECT ${selected} FROM basalt_model_requests
        WHERE id=incoming.id LIMIT 1) AS saved`,
      [JSON.stringify(incoming)],
    );
    if (result.rows.some((row) => row.conflict === true)) throw new HistoryConflict();
    return new Set(result.rows.map((row) => String(row.id)));
  };
  const retained = await existing(values);
  const missing = values.filter((row) => !retained.has(row.id));
  if (!missing.length) return { inserted: 0, existing: values.length, count: values.length };
  // The hours this fills with Home's rows are counted again (capture-hours-mark.ts).
  const result = await db.query(
    `WITH inserted AS (INSERT INTO basalt_model_requests (${selected})
      SELECT ${selected} FROM jsonb_to_recordset($1::jsonb) AS incoming(${types})
      ORDER BY id ON CONFLICT (id) DO NOTHING RETURNING id, pool, timestamp, source)
    ${captureHours ? `, ${markWrittenHours("inserted", "$2")}` : ""}
    SELECT id FROM inserted`,
    [JSON.stringify(missing), ...(captureHours ? [await homeSource()] : [])],
  );
  // Only concurrent conflicts can differ: retained rows are append-only, and RETURNING proves
  // which missing rows this transaction wrote. A new statement sees a conflicting writer's commit.
  const insertedIds = new Set(result.rows.map((row) => String(row.id)));
  const conflicts = missing.filter((row) => !insertedIds.has(row.id));
  if (conflicts.length) await existing(conflicts);
  const inserted = result.rows.length;
  return { inserted, existing: values.length - inserted, count: values.length };
}
