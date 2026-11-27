import { homeHistorySelect } from "./home.ts";
import type { HistoryDatabase } from "./schema.ts";
import { historyBatchSize } from "./store.ts";

/** The most Home ids one session's sweep checks against history. */
export const sweepIdsPerSession = 10_000;
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
}

/**
 * Home allocates an id before its row commits, so the forward pages can pass a row whose
 * transaction is still open. The sweep checks each id the pages passed once, two sessions later:
 * a session sets the range's end to where the forward cursor starts it, and the session after next
 * has that range checked. A check is one probe of history's primary key per id; only the rows
 * history lacks are read in full, at most a batch a session, in id order.
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
 * This session's sweep inside capture's first transaction: the Home rows history lacks, read in
 * full, the ids it checked, and the cursor's sweep fields to store.
 */
export async function sweepLateCommits(db: HistoryDatabase, source: string, cursor: SweepCursor) {
  const forward = BigInt(cursor.forward);
  const lower = larger(BigInt(cursor.sweepId), forward - sweepReachIds);
  const upper = BigInt(cursor.sweepUpper);
  // The range is checked: the next one ends where the forward cursor starts this session.
  const done = (through: bigint) => ({
    sweepId: String(larger(through, lower)),
    sweepUpper: cursor.forward,
  });
  if (upper <= lower) return { rows: [], checked: 0, ...done(upper) };
  const row = (
    await db.query(checkRead, [
      String(lower),
      String(upper),
      sweepIdsPerSession,
      historyBatchSize,
      source,
    ])
  ).rows[0];
  const missing = Array.isArray(row?.missing) ? row.missing.map(String) : [];
  const capped = missing.length >= historyBatchSize;
  // A full batch of missing rows ends the check at its last one; the next session goes on after it.
  const checked = Number(capped ? row?.through_missing : row?.scanned) || 0;
  const last = capped ? row?.last_missing : row?.last;
  const through = typeof last === "string" ? BigInt(last) : upper;
  const rows = missing.length
    ? (
        await db.query(`${homeHistorySelect} WHERE u.id = ANY($1::bigint[]) ORDER BY u.id`, [
          missing,
        ])
      ).rows
    : [];
  const finished =
    through >= upper || (!capped && (Number(row?.scanned) || 0) < sweepIdsPerSession);
  return {
    rows,
    checked,
    ...(finished ? done(upper) : { sweepId: String(through), sweepUpper: cursor.sweepUpper }),
  };
}
