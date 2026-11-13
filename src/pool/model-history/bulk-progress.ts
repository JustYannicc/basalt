import { type BulkDefinition } from "./bulk-contract.ts";
import { parseBulkChunk } from "./bulk-parser.ts";
import { insertBulkRequests } from "./bulk-store.ts";
import { withHistoryDatabase } from "./database.ts";
import { verifyImportAccountTargets } from "./import-account-mapping.ts";
import { HistoryConflict } from "./store.ts";
import type { HistoryDatabase } from "./schema.ts";
import { digest } from "../backend-users.ts";

const fingerprints = new Map<string, string>();

/** Row locks keep disable, unlink and provider changes behind an admitted chunk's commit. */
async function eligibleTargets(db: HistoryDatabase, definition: BulkDefinition) {
  const ids = [...new Set(definition.accountMappings.map((mapping) => mapping.targetAccountId))];
  if (!ids.length) return;
  const result = await db.query(
    `SELECT a.id,a.provider,d.id AS membership,g.id AS group_id FROM auth a
    JOIN channel_group_detail d ON d.auth_id=a.id AND d.deleted_at IS NULL
    JOIN channel_group g ON g.id=d.channel_group_id AND g.deleted_at IS NULL
    WHERE a.id=ANY($1::text[]) AND a.deleted_at IS NULL AND a.disabled=false
      AND g.disabled=false AND g.channel_name=$2
    ORDER BY a.id,d.id FOR SHARE OF a,d,g`,
    [ids, `signalbox-pool-${definition.identity.pool}`],
  );
  const fingerprint = await digest(JSON.stringify(result.rows));
  if (fingerprints.get(definition.job) !== fingerprint) {
    verifyImportAccountTargets(
      definition.accountMappings,
      result.rows.map((row) => ({ id: String(row.id), provider: String(row.provider) })),
    );
    if (fingerprints.size >= 100) fingerprints.delete(fingerprints.keys().next().value!);
    fingerprints.set(definition.job, fingerprint);
  }
}

export async function validateBulkTargets(
  connectionString: string | undefined,
  definition: BulkDefinition,
) {
  return withHistoryDatabase(connectionString, async (db) => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL lock_timeout = '500ms'");
      await db.query("SET LOCAL statement_timeout = '5s'");
      await eligibleTargets(db, definition);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

export async function commitBulkChunk(
  connectionString: string | undefined,
  definition: BulkDefinition,
  index: number,
  data: string,
) {
  const records = await parseBulkChunk(definition, index, data);
  const chunk = definition.manifest.chunks[index]!;
  return withHistoryDatabase(connectionString, async (db) => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL lock_timeout = '500ms'");
      await db.query("SET LOCAL statement_timeout = '5s'");
      const writer = await db.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('basalt:model-history:bulk-writer-v1',0)) AS acquired",
      );
      if (writer.rows[0]?.acquired !== true) throw new Error("Bulk import writer is busy");
      await db.query(
        `INSERT INTO basalt_model_import_jobs
        (id,pool,organization,owner,manifest_digest,map_digest,total_rows,total_chunks)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
        [
          definition.job,
          definition.identity.pool,
          definition.identity.organization,
          definition.identity.owner,
          definition.manifestDigest,
          definition.accountMappingDigest,
          definition.manifest.totalRows,
          definition.manifest.chunks.length,
        ],
      );
      const job = (
        await db.query(
          `SELECT pool,organization,owner,manifest_digest,map_digest,
        total_rows::text,total_chunks FROM basalt_model_import_jobs WHERE id=$1 FOR UPDATE`,
          [definition.job],
        )
      ).rows[0];
      if (
        !job ||
        job.pool !== definition.identity.pool ||
        job.organization !== definition.identity.organization ||
        job.owner !== definition.identity.owner ||
        job.manifest_digest !== definition.manifestDigest ||
        job.map_digest !== definition.accountMappingDigest ||
        Number(job.total_rows) !== definition.manifest.totalRows ||
        Number(job.total_chunks) !== definition.manifest.chunks.length
      )
        throw new HistoryConflict();
      const saved = (
        await db.query(
          `SELECT input_sha,ids_sha,rows,inserted,existing
        FROM basalt_model_import_receipts WHERE job=$1 AND chunk=$2`,
          [definition.job, index],
        )
      ).rows[0];
      if (saved) {
        if (
          saved.input_sha !== chunk.sha256 ||
          saved.ids_sha !== chunk.idsSha256 ||
          Number(saved.rows) !== chunk.rows
        )
          throw new HistoryConflict();
        await db.query("COMMIT");
        return {
          inserted: Number(saved.inserted),
          existing: Number(saved.existing),
          count: Number(saved.rows),
        };
      }
      await eligibleTargets(db, definition);
      const result = await insertBulkRequests(db, records);
      if (result.count !== chunk.rows) throw new HistoryConflict();
      await db.query(
        `INSERT INTO basalt_model_import_receipts
        (job,chunk,input_sha,ids_sha,rows,inserted,existing) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          definition.job,
          index,
          chunk.sha256,
          chunk.idsSha256,
          chunk.rows,
          result.inserted,
          result.existing,
        ],
      );
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}
