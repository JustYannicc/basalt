import type pg from "pg";
import { insertBulkRequests } from "../src/pool/model-history/bulk-store.ts";
import { eligibleTargets } from "../src/pool/model-history/bulk-progress.ts";
import type { BulkDefinition } from "../src/pool/model-history/bulk-contract.ts";
import type { ModelRequest } from "../src/pool/model-history/record.ts";

export const bypasses = ["replica", "guarded"] as const;
export type Bypass = (typeof bypasses)[number];
export const guardSetting = "basalt.history_import";
const trigger = "basalt_pool_change_write";
const bypassSql: Record<Bypass, { on: string; off: string }> = {
  replica: { on: "SET LOCAL session_replication_role = replica", off: "SET LOCAL session_replication_role = origin" },
  guarded: { on: `SET LOCAL ${guardSetting} = 'on'`, off: `SET LOCAL ${guardSetting} = 'off'` },
};
// The definition every Basalt migration installs (change-schema.ts watched list), with any schema prefix.
const original = /^CREATE TRIGGER basalt_pool_change_write AFTER INSERT OR UPDATE ON (?:\w+\.)?basalt_model_requests FOR EACH ROW EXECUTE FUNCTION (?:\w+\.)?basalt_pool_record_change\('history', 'pool', 'pool-usage'\)$/;
const guarded = `CREATE OR REPLACE TRIGGER ${trigger} AFTER INSERT OR UPDATE ON basalt_model_requests FOR EACH ROW
  WHEN (current_setting('${guardSetting}', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION basalt_pool_record_change('history', 'pool', 'pool-usage')`;

export const triggerDefinition = async (db: pg.ClientBase) =>
  (await db.query(`SELECT pg_get_triggerdef(oid) AS sql FROM pg_trigger WHERE tgrelid='basalt_model_requests'::regclass AND tgname=$1`, [trigger])).rows[0]?.sql as string | undefined;
export const triggerShape = (sql: string | undefined) =>
  sql === undefined ? "missing" : original.test(sql) ? "original" : sql.includes(guardSetting) ? "guarded" : "unexpected";

/** The job row must be exactly this descriptor's job: identity, digests and size. */
export const jobMatches = (job: Record<string, unknown> | undefined, def: BulkDefinition) =>
  !!job && job.pool === def.identity.pool && job.organization === def.identity.organization && job.owner === def.identity.owner &&
  job.manifest_digest === def.manifestDigest && job.map_digest === def.accountMappingDigest &&
  Number(job.total_rows) === def.manifest.totalRows && Number(job.total_chunks) === def.manifest.chunks.length;

export async function committedRows(db: pg.ClientBase, job: string) {
  const rows = new Map<number, number>();
  for (const row of (await db.query("SELECT chunk, sum(rows)::int AS n FROM basalt_model_import_receipts WHERE job=$1 GROUP BY chunk", [job])).rows)
    rows.set(Number(row.chunk), Number(row.n));
  return rows;
}

/** commitBulkChunk (bulk-progress.ts) plus a session-only trigger bypass and one pool invalidation. */
export async function commitFinish(db: pg.ClientBase, def: BulkDefinition, index: number, start: number, records: readonly ModelRequest[], bypass: Bypass) {
  const chunk = def.manifest.chunks[index]!;
  const startedAt = Date.now();
  await db.query("BEGIN; SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '10s'");
  try {
    const writer = await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('basalt:model-history:bulk-writer-v1',0)) AS acquired");
    if (writer.rows[0]?.acquired !== true) throw new Error("Bulk import writer is busy");
    const job = (await db.query(`SELECT j.pool,j.organization,j.owner,j.manifest_digest,j.map_digest,j.total_rows::text,j.total_chunks,
        r.input_sha,r.ids_sha,r.rows,r.inserted,r.existing,
        CASE WHEN r.job IS NULL THEN (SELECT COALESCE(sum(rows),0)::int FROM basalt_model_import_receipts WHERE job=j.id AND chunk=$2) END AS committed_rows
      FROM basalt_model_import_jobs j LEFT JOIN basalt_model_import_receipts r ON r.job=j.id AND r.chunk=$2 AND r.start_row=$3
      WHERE j.id=$1 FOR UPDATE OF j`, [def.job, index, start])).rows[0];
    if (!jobMatches(job, def)) throw new Error("Job identity mismatch");
    if (job.input_sha != null) {
      // A retry after a lost COMMIT acknowledgement: the receipt proves what committed.
      if (job.input_sha !== chunk.sha256 || job.ids_sha !== chunk.idsSha256 || Number(job.rows) !== records.length)
        throw new Error("Receipt mismatch");
      await db.query("COMMIT");
      return { inserted: Number(job.inserted), existing: Number(job.existing), elapsedMs: Date.now() - startedAt, replayed: true };
    }
    if (Number(job.committed_rows) !== start) throw new Error("Receipt boundary mismatch");
    await eligibleTargets(db, def);
    await db.query(bypassSql[bypass].on);
    const result = await insertBulkRequests(db, records);
    await db.query(bypassSql[bypass].off);
    if (result.count !== records.length) throw new Error("Duplicate ids inside one chunk");
    await db.query("SELECT basalt_pool_change($1,'pool-usage')", [def.identity.pool]);
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    await db.query(`INSERT INTO basalt_model_import_receipts (job,chunk,start_row,input_sha,ids_sha,rows,inserted,existing,elapsed_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [def.job, index, start, chunk.sha256, chunk.idsSha256, records.length, result.inserted, result.existing, elapsedMs]);
    await db.query("COMMIT");
    return { inserted: result.inserted, existing: result.existing, elapsedMs, replayed: false };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** Path B: swap only from the exact original, restore only from the guarded copy, verified in one transaction. */
export async function swapTrigger(db: pg.ClientBase, install: boolean, saved: string | null) {
  await db.query("BEGIN; SET LOCAL lock_timeout = '2s'");
  try {
    const current = await triggerDefinition(db);
    if (install) {
      if (triggerShape(current) !== "original") throw new Error(`History trigger is ${triggerShape(current)}, not the original`);
      await db.query(guarded);
      if (triggerShape(await triggerDefinition(db)) !== "guarded") throw new Error("Guarded trigger did not install");
    } else {
      if (triggerShape(current) !== "guarded") throw new Error(`History trigger is ${triggerShape(current)}, not the guarded copy`);
      if (!saved || triggerShape(saved) !== "original") throw new Error("Saved trigger definition is not the original");
      await db.query(saved.replace(/^CREATE TRIGGER/, "CREATE OR REPLACE TRIGGER"));
      if ((await triggerDefinition(db)) !== saved) throw new Error("Restored trigger differs from the saved definition");
    }
    await db.query("COMMIT");
    return current!;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
