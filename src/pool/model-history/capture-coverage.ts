import type { HistoryDatabase } from "./schema.ts";
import { postgresCode } from "./usage-rollup-apply.ts";
import { poolUsageRows, poolUsernamePattern, uncaptured, usageHour } from "./capture-population.ts";
import {
  captureLookbackStart,
  captureSettledAfter,
  captureSettleHorizon,
} from "./capture-hours-schema.ts";

export interface HomeCaptureCoverage {
  readonly capturedAt: string | null;
  readonly incompleteHours: ReadonlySet<string> | null;
}

/** Past this many incomplete hours the check names none: the window's capture is unknown. */
const maxIncompleteHours = 800;
const iso = (value: string) =>
  `to_char((${value}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** At most this many ranges in one row check: the closest ones merge, which only checks more hours. */
export const maxRowCheckRanges = 32;
const rowCheckMark = "/* capture row check */";

/**
 * The hours of `ranges` holding a Home usage row of the pool's users with no request: one statement,
 * each range a branch in the window statement's own form with its bounds as parameters, so Postgres
 * plans every branch as it plans that statement, in parallel where it pays.
 * $1 username pattern, $2 pool, $3 Home source, then each range's from and to.
 */
export const rowCheckStatement = (ranges: number) =>
  `${rowCheckMark} SELECT DISTINCT m.hour FROM (${Array.from(
    { length: ranges },
    (_, n) => `SELECT to_char(${usageHour},'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour
    FROM ${poolUsageRows("$1", `u.timestamp >= $${4 + 2 * n}::timestamptz AND u.timestamp < $${5 + 2 * n}::timestamptz`)}
      AND ${uncaptured("$2", "$3")}`,
  ).join("\n  UNION ALL\n  ")}) m
  ORDER BY m.hour LIMIT ${maxIncompleteHours}`;

/** Whether a statement is the counted path's row check, and the ranges it read. */
export const isRowCheck = (text: string) => text.startsWith(rowCheckMark);
export function rowCheckRanges(values: readonly unknown[]) {
  const ranges: { f: string; t: string }[] = [];
  for (let n = 3; n + 1 < values.length; n += 2)
    ranges.push({ f: String(values[n]), t: String(values[n + 1]) });
  return ranges;
}

/** The ranges, merged across their smallest gaps until at most `max` are left. */
export function mergeRanges(ranges: readonly { f: string; t: string }[], max = maxRowCheckRanges) {
  const merged = [...ranges].sort((a, b) => Date.parse(a.f) - Date.parse(b.f));
  const gap = (n: number) => Date.parse(merged[n + 1]!.f) - Date.parse(merged[n]!.t);
  while (merged.length > max) {
    let at = 0;
    for (let n = 1; n < merged.length - 1; n++) if (gap(n) < gap(at)) at = n;
    merged.splice(at, 2, { f: merged[at]!.f, t: merged[at + 1]!.t });
  }
  return merged;
}

/** Every usage row of the window, as the check ran before v17. $1 pattern, $2 from, $3 to, $4 pool, $5 source. */
const windowStatement = `SELECT DISTINCT to_char(${usageHour},'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour
    FROM ${poolUsageRows("$1", "u.timestamp >= $2::timestamptz AND u.timestamp < $3::timestamptz")}
      AND ${uncaptured("$4", "$5")}
    ORDER BY hour LIMIT ${maxIncompleteHours}`;

/**
 * One statement over the window's whole hours before the settle horizon, for a pool ready on v16:
 * an hour whose settled count found every usage row's request and equals the requests v16 holds for
 * the Home source is complete. Every other hour is checked row by row, with the tail since the
 * horizon and the hours a bound cuts: one whose count found a row without its request or whose
 * counts differ, and one with no settled count inside the lookback, as before v17. Consecutive
 * hours to check are one range. Its `bounds` row says whether the pool is ready.
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
    SELECT s.hour, s.usage_requests, s.uncaptured_requests FROM w JOIN basalt_model_capture_hours s
      ON s.pool=$1 AND s.hour >= w.whole_from AND s.hour < w.whole_to
    -- An hour older than the counts' lookback is never complete: it is no longer recounted.
    WHERE w.ready AND ${captureSettledAfter("s")} AND s.hour >= ${captureLookbackStart()}
  ), captured AS (
    SELECT p.hour, sum(p.requests) AS n FROM w JOIN basalt_model_usage_people_hourly p
      ON p.pool=$1 AND p.hour >= w.whole_from AND p.hour < w.whole_to
    WHERE w.ready AND p.source=$4::character(64)
    GROUP BY p.hour
  ), checked AS (
    SELECT h.at, h.at - interval '1 hour' * row_number() OVER (ORDER BY h.at) AS run
    FROM hours h LEFT JOIN stored s ON s.hour=h.at LEFT JOIN captured c ON c.hour=h.at
    WHERE s.hour IS NULL OR s.uncaptured_requests <> 0 OR s.usage_requests <> coalesce(c.n,0)
  )
  SELECT 'bounds' AS kind, w.ready, NULL::text AS f, NULL::text AS t FROM w
  UNION ALL
  SELECT 'check', NULL, ${iso("min(k.at)")}, ${iso("max(k.at) + interval '1 hour'")}
    FROM checked k GROUP BY k.run
  UNION ALL
  SELECT 'check', NULL, ${iso("w.lo")}, ${iso("w.whole_from")}
    FROM w WHERE w.ready AND w.whole_from < w.whole_to AND w.lo < w.whole_from
  UNION ALL
  SELECT 'check', NULL, ${iso("w.whole_to")}, ${iso("w.hi")}
    FROM w WHERE w.ready AND w.whole_from < w.whole_to AND w.whole_to < w.hi
  UNION ALL
  SELECT 'check', NULL, ${iso("w.lo")}, ${iso("w.hi")}
    FROM w WHERE w.ready AND w.whole_from >= w.whole_to`;

/**
 * Reconcile the source to this pool's ledger in the caller's repeatable-read snapshot.
 *
 * With `counted`, a pool ready on the v16 rollup reads the hour counts history migration v17 keeps:
 * an hour whose count proves it is complete without a row check, and every other hour is checked row
 * by row, so while the counts fill the answer is the same as before v17 and only gets cheaper. That
 * row check has its own limit: if it can't answer within it, the hours it covered are unproven, so
 * incomplete, the hours the counts proved stay complete, and the summary still answers. Without v17 or a v16-ready pool, every usage row of the window is
 * checked under the read's own limit, as before.
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
  let ranges: { f: string; t: string }[] | undefined;
  if (counted && available.capture_hours === true) {
    const rows = (await db.query(capturedHoursStatement, [poolHash, from, to, homeSourceHash]))
      .rows;
    if (rows.find((row) => row.kind === "bounds")?.ready === true)
      ranges = rows
        .filter((row) => row.kind === "check")
        .map((row) => ({ f: String(row.f), t: String(row.t) }))
        .sort((a, b) => Date.parse(a.f) - Date.parse(b.f));
  }
  let missing: string[];
  if (!ranges)
    missing = (
      await db.query(windowStatement, [username, from, to, poolHash, homeSourceHash])
    ).rows.map((row) => String(row.hour));
  else if (!ranges.length) missing = [];
  else {
    const checked = await boundedRowCheck(db, mergeRanges(ranges), [
      username,
      poolHash,
      homeSourceHash,
    ]);
    // The row check did not answer in time: the hours it covered are unproven, and only those.
    // Every hour its counts proved stays complete, so a slow check reads partial, never unknown.
    if (!checked) return { capturedAt, incompleteHours: new Set(rangeHours(ranges)) };
    missing = checked;
  }
  // The check named as many missing hours as it may: there may be more, so none is known.
  if (missing.length >= maxIncompleteHours) return { capturedAt, incompleteHours: null };
  return { capturedAt, incompleteHours: new Set(missing) };
}

/** The counted path's row check limit, inside the read's own 5 s. */
export const captureRowCheckLimitMs = 3_000;

/**
 * The row check in a savepoint under its own limit. A Postgres statement timeout gives undefined and
 * leaves the session as it was; any other failure still fails the read.
 */
async function boundedRowCheck(
  db: HistoryDatabase,
  ranges: readonly { f: string; t: string }[],
  values: unknown[],
) {
  await db.query("SAVEPOINT capture_row_check");
  try {
    await db.query("SELECT set_config('statement_timeout',$1,true)", [
      `${captureRowCheckLimitMs}ms`,
    ]);
    const rows = (
      await db.query(rowCheckStatement(ranges.length), [
        ...values,
        ...ranges.flatMap((range) => [range.f, range.t]),
      ])
    ).rows.map((row) => String(row.hour));
    // Rolling back to the savepoint restores the read's own limit, which a release would not.
    await db.query("ROLLBACK TO SAVEPOINT capture_row_check");
    await db.query("RELEASE SAVEPOINT capture_row_check");
    return rows;
  } catch (error) {
    if (postgresCode(error) !== "57014") throw error;
    await db.query("ROLLBACK TO SAVEPOINT capture_row_check");
    await db.query("RELEASE SAVEPOINT capture_row_check");
    return undefined;
  }
}

/** Every UTC hour a range touches, keyed as the row check names them: at most the window's hours. */
function rangeHours(ranges: readonly { f: string; t: string }[]) {
  const hours = new Set<string>();
  for (const range of ranges)
    for (
      let at = Math.floor(Date.parse(range.f) / 3_600_000) * 3_600_000;
      at < Date.parse(range.t);
      at += 3_600_000
    )
      hours.add(new Date(at).toISOString().replace(".000Z", "Z"));
  return [...hours];
}
