import type { HistoryDatabase } from "./schema.ts";

const hex = "0123456789abcdef";
// IDs and source records match ^[0-9a-f]{64}$ (schema check), so [prefix, next prefix) ranges
// ending at "g" cover each row exactly once in a deterministic collation; ranges refuse otherwise.
const bounds = [...[...hex].flatMap((first) => [...hex].map((second) => first + second)), "g"];
const fenceBounds = [...hex, "g"];
export const reconcileRanges = bounds.length - 1;
const rangeBuckets = `SELECT left(id,2) AS bucket, count(*)::bigint AS rows,
    min(timestamp_exact) AS first_at, max(timestamp_exact) AS last_at,
    encode(sha256(convert_to(string_agg(id::text,E'\\n' ORDER BY id),'UTF8')),'hex') AS digest
  FROM basalt_model_requests WHERE pool=$1 AND source=$2 AND id >= $3 AND id < $4 GROUP BY left(id,2)`;
type Scope = { pool: string; source: string };

/** Missing ranges, or (ranges 0) rows added or rewritten since the first range was stored. */
export class ReconcileIncomplete extends Error {
  readonly ranges: number;
  constructor(ranges: number) {
    super("Import completion reconciliation is incomplete");
    this.ranges = ranges;
  }
}

/**
 * The pool connection is transaction-pooled, so every limit is transaction-local. Parallel
 * workers made the fence slices 2.6x slower on the smallest primary (17.8 s vs 6.8 s).
 */
export async function inLimitedTransaction<T>(
  db: HistoryDatabase,
  begin: string,
  work: () => Promise<T>,
): Promise<T> {
  await db.query(`${begin}; SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '5s';
    SET LOCAL work_mem = '8MB'; SET LOCAL max_parallel_workers_per_gather = 0`);
  try {
    const result = await work();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * The source's exact row count, from index-only slices of (source, source_record) so each
 * statement stays inside the statement timeout, plus the table's rewrite counter. History rows
 * are append-only (UPDATE, DELETE and TRUNCATE are refused by trigger), so an equal count means
 * no row was added; the rewrite counter turns a bypassed trigger, or a stats reset, into stale.
 */
async function sourceFence(db: HistoryDatabase, scope: Scope) {
  let rows = 0n;
  for (let index = 0; index + 1 < fenceBounds.length; index++) {
    const slice = await db.query(
      `SELECT count(*)::text AS rows FROM basalt_model_requests
      WHERE source=$1 AND source_record >= $2 AND source_record < $3`,
      [scope.source, fenceBounds[index], fenceBounds[index + 1]],
    );
    rows += BigInt(String(slice.rows[0]!.rows));
  }
  const rewrites = await db.query(
    `SELECT COALESCE(sum(n_tup_upd + n_tup_del),0)::text AS rewrites FROM pg_stat_user_tables
    WHERE schemaname = current_schema() AND relname LIKE 'basalt\\_model\\_requests%'`,
  );
  return { fence: rows.toString(), rewrites: String(rewrites.rows[0]!.rewrites) };
}

/**
 * Stores per-range digests for as many ranges as fit in budgetMs, each range in its own short
 * transaction, so a large source reconciles across operator calls instead of racing the session's
 * total deadline. The first call records the fence the plan checks.
 */
export async function reconcileStep(db: HistoryDatabase, scope: Scope, budgetMs: number) {
  const started = Date.now();
  const stored = (
    await db.query(
      `SELECT range_index, fence::text AS fence, rewrites::text AS rewrites
      FROM basalt_model_import_reconcile WHERE pool=$1 AND source=$2`,
      [scope.pool, scope.source],
    )
  ).rows;
  const fence = stored.length
    ? { fence: String(stored[0]!.fence), rewrites: String(stored[0]!.rewrites) }
    : await inLimitedTransaction(
        db,
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        () => sourceFence(db, scope),
      );
  const done = new Set(stored.map((row) => Number(row.range_index)));
  let computed = 0;
  for (let index = 0; index < reconcileRanges; index++) {
    if (done.has(index)) continue;
    if (computed && Date.now() - started >= budgetMs) break;
    await inLimitedTransaction(db, "BEGIN", async () => {
      const { rows } = await db.query(rangeBuckets, [
        scope.pool,
        scope.source,
        bounds[index],
        bounds[index + 1],
      ]);
      // A range holding any other prefix means the collation does not order hex IDs bytewise.
      if (rows.length > 1 || (rows.length === 1 && rows[0]!.bucket !== bounds[index]))
        throw new Error("Import completion ranges do not match the ID prefixes");
      const row = rows[0];
      await db.query(
        `INSERT INTO basalt_model_import_reconcile
        (pool,source,fence,rewrites,range_index,bucket,rows,first_at,last_at,digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (pool,source,range_index) DO NOTHING`,
        [
          scope.pool,
          scope.source,
          fence.fence,
          fence.rewrites,
          index,
          row?.bucket ?? null,
          row?.rows ?? 0,
          row?.first_at ?? null,
          row?.last_at ?? null,
          row?.digest ?? null,
        ],
      );
    });
    done.add(index);
    computed++;
  }
  return { computed, ranges: done.size, complete: done.size === reconcileRanges };
}

/** Drops stored progress, so the next step starts again from a new fence. */
export async function resetReconcile(db: HistoryDatabase, scope: Scope) {
  await db.query("DELETE FROM basalt_model_import_reconcile WHERE pool=$1 AND source=$2", [
    scope.pool,
    scope.source,
  ]);
}

/**
 * Inside the caller's REPEATABLE READ snapshot: the single-statement reconciliation result from
 * complete progress whose fence still holds; otherwise ReconcileIncomplete. An unchanged fence
 * means every stored digest is still exact.
 */
export async function reconciledProgress(db: HistoryDatabase, scope: Scope) {
  const isolation = await db.query("SELECT current_setting('transaction_isolation') AS level");
  if (isolation.rows[0]?.level !== "repeatable read")
    throw new Error("Import completion reconciliation needs one REPEATABLE READ snapshot");
  const row = (
    await db.query(
      `SELECT count(*)::int AS ranges, count(DISTINCT (fence, rewrites))::int AS fences,
        min(fence)::text AS fence, min(rewrites)::text AS rewrites,
        COALESCE(sum(rows),0)::text AS rows, min(first_at) AS "frozenFrom", max(last_at) AS "frozenTo",
        encode(sha256(convert_to(COALESCE(string_agg(bucket||':'||digest,E'\\n' ORDER BY bucket)
          FILTER (WHERE rows > 0),''),'UTF8')),'hex') AS "idsDigest"
      FROM basalt_model_import_reconcile WHERE pool=$1 AND source=$2`,
      [scope.pool, scope.source],
    )
  ).rows[0]!;
  if (Number(row.ranges) !== reconcileRanges) throw new ReconcileIncomplete(Number(row.ranges));
  const current = await sourceFence(db, scope);
  if (Number(row.fences) !== 1 || current.fence !== row.fence || current.rewrites !== row.rewrites)
    throw new ReconcileIncomplete(0);
  return {
    rows: String(row.rows),
    frozenFrom: row.frozenFrom ?? null,
    frozenTo: row.frozenTo ?? null,
    idsDigest: String(row.idsDigest),
  };
}
