import type { HistoryDatabase } from "./schema.ts";
import {
  captureSettledAfter,
  captureSettleHorizon,
  historyCaptureHoursVersion,
} from "./capture-hours-schema.ts";
import { historyUsagePeopleRollupVersion } from "./usage-rollup-people-schema.ts";

const iso = (value: string) =>
  `to_char((${value}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
/** The most pending hours a plan lists per pool; a session never gets further than this. */
const listedHours = 2_000;

export interface CaptureHoursPool {
  readonly pool: string;
  /** The pool's pending hours before the settle horizon, newest first, at most `listedHours`. */
  readonly hours: readonly string[];
  readonly pending: number;
}

/** How far back from the settle horizon the tick counts: 400 days. Older hours stay unproven. */
export const captureHoursLookbackHours = 400 * 24;

/**
 * The pools to count: every pool ready on v16, imports-only ones included, over the `lookback`
 * hours before the settle horizon. A pending hour has no count, or one taken before it settled;
 * the newest come first, so the overview's usual windows are proven first. Reads v16's ready table
 * and the counts' primary key. Undefined while v16 or v17 is not applied.
 */
export async function planCaptureHours(
  db: HistoryDatabase,
  lookback: number = captureHoursLookbackHours,
) {
  if (!Number.isSafeInteger(lookback) || lookback < 1) throw new Error("Invalid lookback");
  const applied = await db.query(
    "SELECT count(*)::int AS n FROM basalt_model_history_migrations WHERE name=ANY($1::text[])",
    [[historyUsagePeopleRollupVersion, historyCaptureHoursVersion]],
  );
  if (Number(applied.rows[0]?.n) !== 2) return undefined;
  const pending = (h: string) => `FROM generate_series(b.horizon - interval '1 hour', b.first,
      interval '-1 hour') AS ${h}(at)
    WHERE NOT EXISTS (SELECT 1 FROM basalt_model_capture_hours s
      WHERE s.pool=p.pool AND s.hour=${h}.at AND ${captureSettledAfter("s")})`;
  const rows = (
    await db.query(
      `WITH b AS MATERIALIZED (SELECT horizon, horizon - $1::int * interval '1 hour' AS first
        FROM (SELECT ${captureSettleHorizon} AS horizon) h)
      SELECT p.pool, to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS planned_at,
        (SELECT count(*) ${pending("g")})::int AS pending,
        ARRAY(SELECT ${iso("x.at")} FROM (SELECT g.at ${pending("g")} ORDER BY g.at DESC
          LIMIT ${listedHours}) x ORDER BY x.at DESC) AS hours
      FROM basalt_model_usage_people_ready p CROSS JOIN b ORDER BY p.pool`,
      [lookback],
    )
  ).rows;
  return {
    /** When the plan read the counts: a recount takes only hours counted before it. */
    plannedAt: rows.length ? String(rows[0]!.planned_at) : new Date().toISOString(),
    pools: rows.map((row): CaptureHoursPool => ({
      pool: String(row.pool),
      pending: Number(row.pending),
      hours: (row.hours as unknown[]).map(String),
    })),
  };
}

/** The oldest time any settled count was taken, as a strict ISO time; a diagnostic. */
export async function stalestCapture(db: HistoryDatabase) {
  const row = (
    await db.query(`SELECT to_char(min(s.checked_at) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM basalt_model_capture_hours s
      WHERE ${captureSettledAfter("s")}`)
  ).rows[0];
  return typeof row?.at === "string" ? row.at : undefined;
}

/**
 * The settled hours of `pools` counted longest ago and before `before`, for the rolling recount, so
 * an hour this tick just counted is never counted again in it.
 */
export async function stalestHours(
  db: HistoryDatabase,
  pools: readonly string[],
  limit: number,
  before: string,
) {
  if (!pools.length) return [];
  return (
    await db.query(
      `SELECT s.pool, ${iso("s.hour")} AS hour FROM basalt_model_capture_hours s
      WHERE s.pool=ANY($1::text[]) AND ${captureSettledAfter("s")} AND s.checked_at < $3::timestamptz
      ORDER BY s.checked_at, s.pool, s.hour LIMIT $2`,
      [pools, limit, before],
    )
  ).rows.map((row) => ({ pool: String(row.pool), hour: String(row.hour) }));
}

/** Which of `entries` name an hour that now has a settled count. */
export async function countedHours(
  db: HistoryDatabase,
  entries: readonly { pool: string; hour?: string }[],
) {
  const named = entries.filter((entry) => entry.hour);
  if (!named.length) return new Set<string>();
  const done = await db.query(
    `SELECT e.pool, e.hour FROM jsonb_to_recordset($1::jsonb) AS e(pool text, hour text)
    WHERE EXISTS (SELECT 1 FROM basalt_model_capture_hours s
      WHERE s.pool=e.pool AND s.hour=e.hour::timestamptz AND ${captureSettledAfter("s")})`,
    [JSON.stringify(named)],
  );
  return new Set(done.rows.map((row) => `${String(row.pool)}|${String(row.hour)}`));
}
