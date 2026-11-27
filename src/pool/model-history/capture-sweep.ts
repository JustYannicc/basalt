import { homeHistorySelect } from "./home.ts";
import { invalidHistory } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import { historyBatchSize } from "./store.ts";
import { postgresCode } from "./usage-rollup-apply.ts";

/** The most Home ids one check takes. */
export const sweepCheckIds = 2_000;
const checksPerSession = 5;
/** The most Home ids one session's checks take together. */
export const sweepIdsPerSession = sweepCheckIds * checksPerSession;
/**
 * How long one check may run. The checks run inside capture's first transaction, before any forward
 * page, so one past this limit is rolled back to its savepoint: the rest of its range waits for the
 * next session, and the session's pages still land.
 */
export const sweepCheckLimitMs = 2_000;
/** All of a session's checks together; no further check starts with less than the floor left. */
const sweepCheckBudgetMs = 3_000;
const sweepCheckFloorMs = 250;
/**
 * How far behind the forward cursor the sweep reaches. An id further back is not a late commit any
 * more; a row that commits that late shows as uncaptured in its hour's count instead.
 */
export const sweepReachIds = 50_000n;

export interface SweepCursor {
  /** Checked through: the last id of the range the sweep has checked. */
  readonly sweepId: string;
  /** The range's end: the forward cursor when the session before set it. */
  readonly sweepUpper: string;
  readonly forward: string;
  /** The backfill's upper bound: every id at or below it is the backfill's to read. */
  readonly backfillUpper: string;
}

/**
 * Home allocates an id before its row commits, so the forward pages can pass a row whose
 * transaction is still open. The sweep checks each id the pages passed once, two sessions later: a
 * session sets the range's end to where the forward cursor starts it, and the next session checks
 * that range, in checks of up to `sweepCheckIds` ids within the session's budget, going on where it
 * stopped. A check is one probe of history's primary key per id; only the rows history lacks are read
 * in full, at most a batch a session, in id order.
 *
 * Not repaired by itself: a row that commits after its id was checked. Home writes one autocommit
 * row per request, so that window is the commit's own milliseconds; such a row shows as uncaptured
 * in its hour's count, and so in the history gap line and as a partial hour in the summary.
 */
const checkRead = `WITH s AS MATERIALIZED (
    SELECT u.id FROM usage u WHERE u.id > $1::bigint AND u.id <= $2::bigint ORDER BY u.id LIMIT $3
  ), m AS MATERIALIZED (
    -- One lookup per id, as an import's held check: a probe prunes history's hash partitions.
    SELECT s.id FROM s LEFT JOIN LATERAL (
      SELECT true AS held FROM basalt_model_requests r
      WHERE r.id=encode(sha256(convert_to('["'||$5::text||'","'
        ||encode(sha256(convert_to('["usage","'||s.id::text||'"]','UTF8')),'hex')||'"]','UTF8')),'hex')::character(64)
      LIMIT 1
    ) h ON true
    WHERE h.held IS NULL ORDER BY s.id LIMIT $4
  )
  SELECT (SELECT count(*) FROM s)::int AS scanned, (SELECT max(id) FROM s)::text AS last,
    (SELECT max(id) FROM m)::text AS last_missing,
    (SELECT count(*) FROM s WHERE s.id <= (SELECT max(id) FROM m))::int AS through_missing,
    COALESCE((SELECT array_agg(id::text ORDER BY id) FROM m), '{}'::text[]) AS missing`;

const larger = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * One check of (from, upper] under its own savepoint and limit; "cut" when Postgres cancelled it at
 * that limit. The check reads only: rolling back to its savepoint afterwards undoes nothing but its
 * own limit, so the session's own is back either way.
 */
async function checkOnce(
  db: HistoryDatabase,
  source: string,
  range: { from: bigint; upper: bigint },
  missingCap: number,
  limitMs: number,
) {
  await db.query("SAVEPOINT late_commit_check");
  let row: Record<string, unknown> | undefined;
  let cut = false;
  try {
    await db.query("SELECT set_config('statement_timeout',$1,true)", [`${limitMs}ms`]);
    row = (
      await db.query(checkRead, [
        String(range.from),
        String(range.upper),
        sweepCheckIds,
        missingCap,
        source,
      ])
    ).rows[0];
  } catch (error) {
    if (postgresCode(error) !== "57014") throw error;
    cut = true;
  }
  await db.query("ROLLBACK TO SAVEPOINT late_commit_check");
  await db.query("RELEASE SAVEPOINT late_commit_check");
  if (cut) return "cut" as const;
  if (!Array.isArray(row?.missing)) return invalidHistory();
  const missing = row.missing.map(String);
  const capped = missing.length >= missingCap;
  // A full batch of missing rows ends the check at its last one; the next check goes on after it.
  const last = capped ? row.last_missing : row.last;
  const through = typeof last === "string" ? BigInt(last) : range.upper;
  return {
    missing,
    capped,
    checked: Number(capped ? row.through_missing : row.scanned) || 0,
    through,
    finished: through >= range.upper || (!capped && (Number(row.scanned) || 0) < sweepCheckIds),
  };
}

/**
 * This session's sweep inside capture's first transaction: the Home rows history lacks, read in
 * full, the ids it checked, whether a check ran out its limit, and the cursor's sweep fields to store.
 */
export async function sweepLateCommits(
  db: HistoryDatabase,
  source: string,
  cursor: SweepCursor,
  now = () => performance.now(),
) {
  const forward = BigInt(cursor.forward);
  const lower = larger(
    larger(BigInt(cursor.sweepId), forward - sweepReachIds),
    BigInt(cursor.backfillUpper),
  );
  const upper = BigInt(cursor.sweepUpper);
  // The range is checked: the next one ends where the forward cursor starts this session.
  const done = (through: bigint) => ({
    sweepId: String(larger(through, lower)),
    sweepUpper: cursor.forward,
  });
  if (upper <= lower) return { rows: [], checked: 0, deferred: false, ...done(upper) };
  const started = now();
  const missing: string[] = [];
  let from = lower,
    checked = 0,
    deferred = false,
    finished = false;
  for (let check = 0; check < checksPerSession && missing.length < historyBatchSize; check++) {
    const left = Math.floor(sweepCheckBudgetMs - (now() - started));
    if (left < sweepCheckFloorMs) break;
    const result = await checkOnce(
      db,
      source,
      { from, upper },
      historyBatchSize - missing.length,
      Math.min(sweepCheckLimitMs, left),
    );
    // Past its limit: the rest of the range stays as it was, neither skipped nor finished.
    if (result === "cut") {
      deferred = true;
      break;
    }
    missing.push(...result.missing);
    checked += result.checked;
    from = result.through;
    if (result.finished) {
      finished = true;
      break;
    }
  }
  const read = missing.length
    ? (
        await db.query(`${homeHistorySelect} WHERE u.id = ANY($1::bigint[]) ORDER BY u.id`, [
          missing,
        ])
      ).rows
    : [];
  // One row per id: a second join match must not grow the batch past its limit.
  const ids = new Set<string>();
  const rows: typeof read = [];
  for (const found of read) {
    const id = String(found.source_id);
    if (ids.has(id)) continue;
    ids.add(id);
    rows.push(found);
  }
  if (finished) return { rows, checked, deferred, ...done(upper) };
  return {
    rows,
    checked,
    deferred,
    // Nothing checked keeps the cursor's own fields: a cut first check moves nothing.
    sweepId: checked ? String(from) : cursor.sweepId,
    sweepUpper: cursor.sweepUpper,
  };
}
