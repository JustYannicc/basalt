import { digest } from "../backend-users.ts";
import { homeHistorySelect, homeHistorySource, homeRequest } from "./home.ts";
import { invalidHistory, type ModelRequest } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import { retainedProjection, retainedRequest } from "./retained.ts";
import { HistoryConflict } from "./store.ts";

/** Resolve local attempts before assigning import ownership, regardless of ingestion order. */
export async function resolveImportIdentity(db: HistoryDatabase, records: readonly ModelRequest[], local: boolean, usageIds: readonly (string | null)[]) {
  const source = await digest(homeHistorySource);
  const identities = new Map(await Promise.all(records.filter((row) => local || row.requestId)
    .map(async (row) => [row.sourceRecord, await digest(JSON.stringify([source, row.sourceRecord]))] as const)));
  const retained = await db.query(`SELECT ${retainedProjection}
    FROM basalt_model_requests WHERE id=ANY($1::text[]) AND source=$2`, [[...identities.values()], source]);
  const byId = new Map(retained.rows.map(retainedRequest).map((row) => [row.id, row]));
  const pending = records.filter((row) => !byId.has(identities.get(row.sourceRecord) ?? ""));
  const found = pending.length ? await db.query(`${homeHistorySelect} WHERE u.request_id=ANY($1::text[]) OR u.id=ANY($2::bigint[])`,
    [pending.flatMap((row) => row.requestId ? [row.requestId] : []), local ? usageIds.filter((id) => id !== null) : []]) : { rows: [] };
  const canonical = new Map((await Promise.all(found.rows.map((row) => homeRequest(row, source))))
    .map((row) => [row.sourceRecord, row]));
  return records.map((row) => {
    const saved = byId.get(identities.get(row.sourceRecord) ?? "");
    if (saved) {
      if (saved.pool !== row.pool) throw new HistoryConflict();
      return saved;
    }
    const home = canonical.get(row.sourceRecord);
    if (home) {
      if (home.pool !== row.pool) throw new HistoryConflict();
      return home;
    }
    if (local) return invalidHistory();
    return row;
  });
}
