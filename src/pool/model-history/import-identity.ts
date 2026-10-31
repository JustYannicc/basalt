import { homeHistorySelect, homeRequest } from "./home.ts";
import { invalidHistory, type ModelRequest } from "./record.ts";
import { requireHomePrivacyReady } from "./privacy.ts";
import type { HistoryDatabase } from "./schema.ts";
import { retainedProjection, retainedRequest } from "./retained.ts";
import { HistoryConflict } from "./store.ts";

/** Local exports bind to this Home database; remote usage IDs belong to their source namespace. */
export async function resolveImportIdentity(db: HistoryDatabase, records: readonly ModelRequest[], local: boolean, usageIds: readonly (string | null)[]) {
  if (!local) return [...records];
  if (usageIds.length !== records.length || usageIds.some((id) => id === null || id === "0")) return invalidHistory();
  await requireHomePrivacyReady(db);
  const retained = await db.query(`SELECT ${retainedProjection}
    FROM basalt_model_requests WHERE id=ANY($1::text[])`, [records.map((row) => row.id)]);
  const byId = new Map(retained.rows.map(retainedRequest).map((row) => [row.id, row]));
  const pending = usageIds.filter((_, index) => !byId.has(records[index]!.id));
  const found = pending.length ? await db.query(`${homeHistorySelect} WHERE u.id=ANY($1::bigint[])`, [pending]) : { rows: [] };
  const source = records[0]?.source;
  const canonical = new Map((source ? await Promise.all(found.rows.map((row) => homeRequest(row, source))) : [])
    .map((row) => [row.id, row]));
  return records.map((row) => {
    const home = byId.get(row.id) ?? canonical.get(row.id);
    if (!home) return invalidHistory();
    if (home.pool !== row.pool) throw new HistoryConflict();
    return home;
  });
}
