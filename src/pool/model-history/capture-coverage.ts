import type { HistoryDatabase } from "./schema.ts";
import { poolUsageRows, poolUsernamePattern, uncaptured, usageHour } from "./capture-population.ts";
import { captureSettledAfter, captureSettleHorizon } from "./capture-hours-schema.ts";

export interface HomeCaptureCoverage {
  readonly capturedAt: string | null;
  readonly incompleteHours: ReadonlySet<string> | null;
}

/** Past this many incomplete hours the check names none: the window's capture is unknown. */
const maxIncompleteHours = 800;
const iso = (value: string) =>
  `to_char((${value}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The hours of `ranges` holding a Home usage row of the pool's users with no request. One statement;
 * each range is its own scan of Home's usage time index. $1 username pattern, $2 ranges as
 * [{f,t}], $3 pool, $4 Home source.
 */
const missingStatement = `SELECT DISTINCT m.hour FROM jsonb_to_recordset($2::jsonb) AS w(f text, t text)
  CROSS JOIN LATERAL (
    SELECT to_char(${usageHour},'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour
    FROM ${poolUsageRows("$1", "u.timestamp >= w.f::timestamptz AND u.timestamp < w.t::timestamptz")}
      AND ${uncaptured("$3", "$4")}
  ) m
  ORDER BY m.hour LIMIT ${maxIncompleteHours}`;

/** Every usage row of the window, as the check ran before v17. $1 pattern, $2 from, $3 to, $4 pool, $5 source. */
const windowStatement = `SELECT DISTINCT to_char(${usageHour},'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour
    FROM ${poolUsageRows("$1", "u.timestamp >= $2::timestamptz AND u.timestamp < $3::timestamptz")}
      AND ${uncaptured("$4", "$5")}
    ORDER BY hour LIMIT ${maxIncompleteHours}`;

/**
 * One statement over the window's whole hours before the settle horizon, for a pool ready on v16:
 * an hour whose settled count equals the requests v16 holds for the Home source is complete; one
 * without a settled count is unproven; one whose counts differ is checked row by row, with the tail
 * since the horizon and the hours a bound cuts. Its `bounds` row says whether the pool is ready.
 * $1 pool, $2 from, $3 to, $4 Home source.
 */
export const capturedHoursStatement = `WITH w AS MATERIALIZED (
    SELECT b.*, date_trunc('hour',b.lo,'UTC')
        + CASE WHEN date_trunc('hour',b.lo,'UTC')=b.lo THEN interval '0' ELSE interval '1 hour' END
        AS whole_from,
      LEAST(b.horizon,date_trunc('hour',b.hi,'UTC')) AS whole_to
    FROM (SELECT EXISTS (SELECT 1 FROM basalt_model_usage_people_ready r WHERE r.pool=$1) AS ready,
      ${captureSettleHorizon} AS horizon, $2::timestamptz AS lo, $3::timestamptz AS hi) b
  ), hours AS (
    SELECT h.at FROM w CROSS JOIN LATERAL generate_series(w.whole_from,
      w.whole_to - interval '1 hour', interval '1 hour') AS h(at)
    WHERE w.ready AND w.whole_from < w.whole_to
  ), stored AS (
    SELECT s.hour, s.usage_requests FROM w JOIN basalt_model_capture_hours s
      ON s.pool=$1 AND s.hour >= w.whole_from AND s.hour < w.whole_to
    WHERE w.ready AND ${captureSettledAfter("s")}
  ), captured AS (
    SELECT p.hour, sum(p.requests) AS n FROM w JOIN basalt_model_usage_people_hourly p
      ON p.pool=$1 AND p.hour >= w.whole_from AND p.hour < w.whole_to
    WHERE w.ready AND p.source=$4::character(64)
    GROUP BY p.hour
  ), judged AS MATERIALIZED (
    SELECT h.at, CASE WHEN s.hour IS NULL THEN 'unproven'
        WHEN s.usage_requests <> coalesce(c.n,0) THEN 'check' END AS kind
    FROM hours h LEFT JOIN stored s ON s.hour=h.at LEFT JOIN captured c ON c.hour=h.at
  )
  SELECT 'bounds' AS kind, w.ready, NULL::text AS hour, NULL::text AS f, NULL::text AS t FROM w
  UNION ALL
  (SELECT 'unproven', NULL, to_char(j.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), NULL, NULL
    FROM judged j WHERE j.kind='unproven' ORDER BY j.at LIMIT ${maxIncompleteHours})
  UNION ALL
  SELECT 'check', NULL, NULL, ${iso("j.at")}, ${iso("j.at + interval '1 hour'")}
    FROM judged j WHERE j.kind='check'
  UNION ALL
  SELECT 'check', NULL, NULL, ${iso("w.lo")}, ${iso("w.whole_from")}
    FROM w WHERE w.ready AND w.whole_from < w.whole_to AND w.lo < w.whole_from
  UNION ALL
  SELECT 'check', NULL, NULL, ${iso("w.whole_to")}, ${iso("w.hi")}
    FROM w WHERE w.ready AND w.whole_from < w.whole_to AND w.whole_to < w.hi
  UNION ALL
  SELECT 'check', NULL, NULL, ${iso("w.lo")}, ${iso("w.hi")}
    FROM w WHERE w.ready AND w.whole_from >= w.whole_to`;

/**
 * Reconcile the source to this pool's ledger in the caller's repeatable-read snapshot.
 *
 * With `counted`, a pool ready on the v16 rollup reads the hour counts history migration v17 keeps:
 * only the hours whose counts differ, the tail since the settle horizon and the hours a bound cuts
 * are checked row by row, and an hour without a settled count is unproven, so incomplete, and never
 * read row by row. Without v17 or a v16-ready pool, every usage row of the window is checked.
 */
export async function homeCaptureCoverage(
  db: HistoryDatabase,
  poolHash: string,
  homeSourceHash: string,
  from: string,
  to: string,
  counted = false,
): Promise<HomeCaptureCoverage> {
  const schema =
    await db.query(`SELECT to_regclass('usage') AS usage,to_regclass('billing_charge') AS charge,
    to_regclass('api_key') AS api_key,to_regclass('user') AS users,
    to_regclass('basalt_model_capture_hours') IS NOT NULL
      AND to_regclass('basalt_model_usage_people_ready') IS NOT NULL AS capture_hours,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at`);
  const available = schema.rows[0];
  const value = available?.captured_at;
  if (value !== null && value !== undefined && typeof value !== "string")
    throw new Error("Invalid capture time");
  const capturedAt = value ?? null;
  if (!available?.usage || !available.charge || !available.api_key || !available.users)
    return { capturedAt, incompleteHours: null };
  const username = poolUsernamePattern(poolHash);
  let unproven: string[] = [];
  let ranges: { f: string; t: string }[] | undefined;
  if (counted && available.capture_hours === true) {
    const rows = (await db.query(capturedHoursStatement, [poolHash, from, to, homeSourceHash]))
      .rows;
    if (rows.find((row) => row.kind === "bounds")?.ready === true) {
      unproven = rows.filter((row) => row.kind === "unproven").map((row) => String(row.hour));
      if (unproven.length >= maxIncompleteHours) return { capturedAt, incompleteHours: null };
      ranges = rows
        .filter((row) => row.kind === "check")
        .map((row) => ({ f: String(row.f), t: String(row.t) }));
    }
  }
  const read = !ranges
    ? db.query(windowStatement, [username, from, to, poolHash, homeSourceHash])
    : ranges.length
      ? db.query(missingStatement, [username, JSON.stringify(ranges), poolHash, homeSourceHash])
      : undefined;
  const missing = read ? (await read).rows.map((row) => String(row.hour)) : [];
  const incomplete = new Set([...unproven, ...missing]);
  if (missing.length >= maxIncompleteHours || incomplete.size >= maxIncompleteHours)
    return { capturedAt, incompleteHours: null };
  return { capturedAt, incompleteHours: incomplete };
}
