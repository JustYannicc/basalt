import { digest } from "../backend-users.ts";
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
  /** The pool's pending hours before the settle horizon, oldest first, at most `listedHours`. */
  readonly hours: readonly string[];
  readonly pending: number;
}

/**
 * The pools to count: each pool ready on v16 that has native rows, from the hour of its first
 * native group up to the settle horizon. A pending hour has no count, or one taken before it
 * settled. Reads v16's ready table, the first of each pool's native groups by its pool-hour index,
 * and the counts' primary key. Undefined while v16 or v17 is not applied.
 */
export async function planCaptureHours(db: HistoryDatabase) {
  const applied = await db.query(
    "SELECT count(*)::int AS n FROM basalt_model_history_migrations WHERE name=ANY($1::text[])",
    [[historyUsagePeopleRollupVersion, historyCaptureHoursVersion]],
  );
  if (Number(applied.rows[0]?.n) !== 2) return undefined;
  const pending = (h: string) => `FROM generate_series(p.first, b.horizon - interval '1 hour',
      interval '1 hour') AS ${h}(at)
    WHERE NOT EXISTS (SELECT 1 FROM basalt_model_capture_hours s
      WHERE s.pool=p.pool AND s.hour=${h}.at AND ${captureSettledAfter("s")})`;
  const rows = (
    await db.query(
      `WITH b AS MATERIALIZED (SELECT ${captureSettleHorizon} AS horizon), p AS MATERIALIZED (
        SELECT r.pool, (SELECT min(h.hour) FROM basalt_model_usage_people_hourly h
          WHERE h.pool=r.pool AND h.source=$1::character(64)) AS first
        FROM basalt_model_usage_people_ready r
      )
      SELECT p.pool, to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS planned_at,
        (SELECT count(*) ${pending("g")})::int AS pending,
        ARRAY(SELECT ${iso("x.at")} FROM (SELECT g.at ${pending("g")} ORDER BY g.at
          LIMIT ${listedHours}) x ORDER BY x.at) AS hours
      FROM p CROSS JOIN b WHERE p.first IS NOT NULL ORDER BY p.pool`,
      [await digest("home-local-v1")],
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
