import type { HistoryDatabase } from "./schema.ts";
import {
  captureSettledAfter,
  captureSettleHorizon,
  historyCaptureHoursVersion,
} from "./capture-hours-schema.ts";
import { historyUsagePeopleRollupVersion } from "./usage-rollup-people-schema.ts";

const iso = (value: string) =>
  `to_char((${value}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/**
 * The unit the tick counts: one pool's six UTC hours [00, 06), [06, 12), [12, 18), [18, 24) in one
 * statement. A whole day of a dense pool, 50,000 usage rows, took 565 ms locally against the 1 s
 * limit and production about six times slower; six hours of it took about 140 ms.
 */
export const captureBlockHours = 6;
/** The block an hour belongs to, in SQL. */
const blockOf = (at: string) =>
  `(date_trunc('day',${at},'UTC') + floor(extract(hour FROM ${at} AT TIME ZONE 'UTC') / ${captureBlockHours}) * interval '${captureBlockHours} hours')`;
/** The most pending blocks a plan lists per pool; a session never gets further than this. */
export const listedBlocks = 100;

/** One pool's hours [from, to): a whole block, or the part of one the lookback or horizon cuts. */
export interface CaptureBlock {
  readonly pool: string;
  readonly from: string;
  readonly to: string;
  /** For a pending block, its hours without a settled count. */
  readonly missing?: number;
}

export interface CaptureHoursPool {
  readonly pool: string;
  /** The pool's pending blocks before the settle horizon, newest first, at most `listedBlocks`. */
  readonly blocks: readonly CaptureBlock[];
  readonly pendingBlocks: number;
  readonly pendingHours: number;
}

/**
 * How far back from the settle horizon the tick counts: 400 days. An hour never counted inside it
 * stays unproven; one counted while inside it keeps its stored count, which the summary still
 * compares, since nothing prunes it.
 */
export const captureHoursLookbackHours = 400 * 24;

/**
 * The pools to count: every pool ready on v16, imports-only ones included, over the `lookback`
 * hours before the settle horizon. A pending block has an hour with no count, or one taken before
 * it settled; the newest come first, so the overview's usual windows are proven first. Two
 * statements whatever the pools and their hours: each pool's settled hours are one range of the
 * counts' primary key, grouped by block against the lookback's blocks. Undefined while v16 or v17
 * is not applied.
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
  const rows = (
    await db.query(
      `WITH b AS MATERIALIZED (SELECT horizon, horizon - $1::int * interval '1 hour' AS first,
          to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS planned_at
        FROM (SELECT ${captureSettleHorizon} AS horizon) h)
      SELECT p.pool, b.planned_at, q.pending_blocks, q.pending_hours, q.blocks
      FROM basalt_model_usage_people_ready p CROSS JOIN b
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS pending_blocks, coalesce(sum(k.missing),0)::int AS pending_hours,
          (array_agg(${iso("k.lo")}||' '||${iso("k.hi")}||' '||k.missing ORDER BY k.lo DESC)
            FILTER (WHERE k.rank <= ${listedBlocks})) AS blocks
        FROM (
          SELECT g.lo, g.hi, g.expected - coalesce(d.n,0) AS missing,
            row_number() OVER (ORDER BY g.lo DESC) AS rank
          FROM (
            SELECT GREATEST(x.at, b.first) AS lo, LEAST(x.at + interval '${captureBlockHours} hours', b.horizon) AS hi,
              (extract(epoch FROM LEAST(x.at + interval '${captureBlockHours} hours', b.horizon)
                - GREATEST(x.at, b.first)) / 3600)::int AS expected
            FROM generate_series(${blockOf("(b.horizon - interval '1 hour')")}, ${blockOf("b.first")},
              interval '-${captureBlockHours} hours') x(at)
          ) g
          LEFT JOIN (
            SELECT ${blockOf("s.hour")} AS block, count(*)::int AS n FROM basalt_model_capture_hours s
            WHERE s.pool=p.pool AND s.hour >= b.first AND s.hour < b.horizon AND ${captureSettledAfter("s")}
            GROUP BY 1
          ) d ON d.block=${blockOf("g.lo")}
          WHERE coalesce(d.n,0) < g.expected
        ) k
      ) q
      ORDER BY p.pool`,
      [lookback],
    )
  ).rows;
  return {
    /** When the plan read the counts: a recount takes only hours counted before it. */
    plannedAt: rows.length ? String(rows[0]!.planned_at) : new Date().toISOString(),
    pools: rows.map((row): CaptureHoursPool => {
      const pool = String(row.pool);
      return {
        pool,
        pendingBlocks: Number(row.pending_blocks),
        pendingHours: Number(row.pending_hours),
        blocks: ((row.blocks as unknown[] | null) ?? []).map((value) => {
          const [from, to, missing] = String(value).split(" ");
          return { pool, from: from!, to: to!, missing: Number(missing) };
        }),
      };
    }),
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
 * The blocks of `pools` to recount, counted longest ago, in one ordered read of the counts' time
 * index: only settled hours counted over an hour ago and before `before`, so a block this tick or
 * the last hour counted is never recounted. Each block comes once, with its whole range clipped to
 * the lookback and horizon.
 */
export async function recountBlocks(
  db: HistoryDatabase,
  pools: readonly string[],
  limit: number,
  before: string,
  lookback: number = captureHoursLookbackHours,
) {
  if (!pools.length) return [];
  return (
    await db.query(
      `SELECT k.pool, ${iso("GREATEST(k.block, b.first)")} AS lo,
        ${iso(`LEAST(k.block + interval '${captureBlockHours} hours', b.horizon)`)} AS hi
      FROM (SELECT ${captureSettleHorizon} AS horizon,
          ${captureSettleHorizon} - $4::int * interval '1 hour' AS first) b
      CROSS JOIN LATERAL (
        SELECT DISTINCT ON (o.pool, o.block) o.pool, o.block, o.checked_at FROM (
          SELECT s.pool, ${blockOf("s.hour")} AS block, s.checked_at
          FROM basalt_model_capture_hours s
          WHERE s.checked_at < LEAST($3::timestamptz, now() - interval '1 hour')
            AND s.pool=ANY($1::text[]) AND ${captureSettledAfter("s")}
            AND s.hour >= b.first AND s.hour < b.horizon
          ORDER BY s.checked_at LIMIT $2::int * ${captureBlockHours}
        ) o ORDER BY o.pool, o.block, o.checked_at
      ) k
      ORDER BY k.checked_at, k.pool, k.block LIMIT $2`,
      [pools, limit, before, lookback],
    )
  ).rows.map((row): CaptureBlock => ({
    pool: String(row.pool),
    from: String(row.lo),
    to: String(row.hi),
  }));
}

/** The hours of a block that have no settled count, for a block counted hour by hour. */
export async function pendingHoursOf(db: HistoryDatabase, block: CaptureBlock) {
  return (
    await db.query(
      `SELECT ${iso("h.at")} AS hour FROM generate_series($2::timestamptz,
        $3::timestamptz - interval '1 hour', interval '1 hour') h(at)
      WHERE NOT EXISTS (SELECT 1 FROM basalt_model_capture_hours s
        WHERE s.pool=$1 AND s.hour=h.at AND ${captureSettledAfter("s")})
      ORDER BY h.at DESC`,
      [block.pool, block.from, block.to],
    )
  ).rows.map((row) => String(row.hour));
}

/** How long one of the tick's reads may run: 1 s, never past what the session has left. */
export const captureHoursReadLimitMs = 1_000;

/** `work`'s reads in one read-only transaction, each statement under the read limit. */
export async function boundedRead<T>(
  db: HistoryDatabase,
  left: () => number,
  work: () => Promise<T>,
): Promise<T> {
  await db.query("BEGIN TRANSACTION READ ONLY");
  try {
    await db.query("SELECT set_config('statement_timeout',$1,true)", [
      `${Math.max(50, Math.min(captureHoursReadLimitMs, Math.floor(left())))}ms`,
    ]);
    const result = await work();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
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
