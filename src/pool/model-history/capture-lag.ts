import { digest } from "../backend-users.ts";
import { reportingCadence } from "../reporting.ts";
import { poolUsernamePattern } from "./capture-population.ts";
import { timestamp } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import { requestCount } from "./series-coverage.ts";

/** Home rows past the cursor that one read considers, whichever pool they belong to. */
export const captureLagRows = 10_000;

export interface CaptureLag {
  /** One of this pool's requests that Home wrote a capture interval before the latest capture is
   * still not in history; or the read stopped at its bound inside such rows. */
  readonly lagging: boolean;
  /** This pool's requests past the cursor among the rows read. */
  readonly pending: number;
  readonly oldestAt: string | null;
  /** False when the read stopped at its bound, so `pending` is a lower bound. */
  readonly complete: boolean;
}

/**
 * Home writes one usage row when a request finishes: its start, and its latency, or a negative
 * latency when Home could not measure it. A row with a latency was written when it finished; ids
 * follow write order, so a row without one was written before any later row whose finish is known.
 * A row is overdue once Home wrote it a capture interval before the latest capture. Each row's
 * owner is resolved by key, as capture resolves it: the charge's user, else the key's current user.
 */
const lagRead = `WITH pending AS MATERIALIZED (
    SELECT u.id, u.timestamp, owner.id AS owner, u.latency_ms >= 0 AS timed,
      u.latency_ms >= 0 AND u.timestamp + u.latency_ms * interval '1 millisecond' < $4::timestamptz AS late
    FROM (SELECT id,timestamp,latency_ms,api_key FROM usage WHERE id > $2::bigint ORDER BY id LIMIT $3) u
    CROSS JOIN LATERAL (SELECT COALESCE(
      (SELECT c.user_id FROM billing_charge c WHERE c.usage_id=u.id LIMIT 1),
      (SELECT k.user_id FROM api_key k WHERE k.diagnostic_fingerprint=u.api_key
        AND u.api_key ~ '^sha256:[0-9a-f]{64}$' LIMIT 1)) AS id) owner
  ), mine AS MATERIALIZED (
    -- Only the owners the read found are matched against the pool's user names.
    SELECT a.id FROM "user" a WHERE a.id IN (SELECT owner FROM pending) AND a.username ~ $1
  ), written AS (
    SELECT max(id) AS id FROM pending WHERE late
  )
  SELECT count(*) FILTER (WHERE owner IN (SELECT id FROM mine))::text AS pending,
    count(*) FILTER (WHERE owner IN (SELECT id FROM mine)
      AND id <= (SELECT id FROM written))::text AS overdue,
    count(*)::text AS scanned,
    -- Overdue rows may go on past the read unless a timed row after the last overdue one is not late.
    ((SELECT id FROM written) IS NOT NULL AND NOT bool_or(timed AND NOT late AND id > (SELECT id FROM written))
      IS TRUE) AS bound_overdue,
    to_char(min(timestamp) FILTER (WHERE owner IN (SELECT id FROM mine))
      AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS oldest_at
  FROM pending`;

/** Bounded by `limit` rows past the cursor, each found by key; another pool's backlog never counts. */
export async function readCaptureLag(
  db: HistoryDatabase,
  pool: string,
  forwardId: string,
  capturedAt: string,
  limit = captureLagRows,
): Promise<CaptureLag> {
  const written = new Date(Date.parse(capturedAt) - reportingCadence).toISOString();
  const row = (
    await db.query(lagRead, [
      poolUsernamePattern((await digest(pool)).slice(0, 16)),
      forwardId,
      limit,
      written,
    ])
  ).rows[0];
  const pending = requestCount(row?.pending),
    scanned = requestCount(row?.scanned);
  const complete = scanned < limit;
  return {
    // A full read that may stop inside the overdue rows proves no pool's are captured.
    lagging: requestCount(row?.overdue) > 0 || (!complete && row?.bound_overdue === true),
    pending,
    oldestAt: typeof row?.oldest_at === "string" ? timestamp(row.oldest_at) : null,
    complete,
  };
}
