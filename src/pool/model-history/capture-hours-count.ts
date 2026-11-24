import type { HistoryDatabase } from "./schema.ts";
import { captureHoursLockClass } from "./capture-hours-schema.ts";
import { poolUsageRows, poolUsernamePattern, uncaptured, usageHour } from "./capture-population.ts";
import { homeHistorySource } from "./home.ts";
import { digest } from "../backend-users.ts";
import { postgresCode } from "./usage-rollup-apply.ts";

/** How long one block's count may run; past it a block splits into hours, and an hour is slow. */
export const captureHoursCountLimitMs = 1_000;
/** The shortest a count is given: one the session's budget cuts shorter is a budget stop. */
export const captureHoursMinCountMs = 50;
/** Another session holding the pool makes the count step aside; this many refusals end the block. */
const refusalsAllowed = 5;

/**
 * One statement: try-locks the pool, and only if it holds it reads the Home usage rows of the
 * pool's users in [$2, $3) through Home's usage time index, counts them by hour, probes each one's
 * request by its key as the summary's per-row check does, and stores every hour of the range,
 * empty ones as zero, with this transaction's time. A refused lock reads and writes nothing.
 * $1 pool, $2 first hour, $3 the hour after the last, $4 username pattern, $5 Home source.
 */
export const countBlockStatement = `WITH l AS MATERIALIZED (
    SELECT pg_try_advisory_xact_lock(${captureHoursLockClass},hashtext($1::text)) AS locked
  ), n AS MATERIALIZED (
    SELECT ${usageHour} AT TIME ZONE 'UTC' AS hour, count(*)::int AS usage_requests,
      (count(*) FILTER (WHERE ${uncaptured("$1::varchar", "$5")}))::int AS uncaptured_requests
    FROM ${poolUsageRows(
      "$4::text",
      "u.timestamp >= $2::timestamptz AND u.timestamp < $3::timestamptz",
    )}
      AND (SELECT locked FROM l)
    GROUP BY 1
  ), w AS (
    INSERT INTO basalt_model_capture_hours AS s
      (pool,hour,usage_requests,uncaptured_requests,checked_at)
    SELECT $1::varchar,h.at,coalesce(n.usage_requests,0),coalesce(n.uncaptured_requests,0),
      transaction_timestamp()
    FROM generate_series($2::timestamptz,$3::timestamptz - interval '1 hour',interval '1 hour') h(at)
    LEFT JOIN n ON n.hour=h.at
    WHERE (SELECT locked FROM l)
    ON CONFLICT (pool,hour) DO UPDATE
      SET usage_requests=EXCLUDED.usage_requests,
        uncaptured_requests=EXCLUDED.uncaptured_requests,checked_at=EXCLUDED.checked_at
    RETURNING 1
  )
  SELECT (SELECT locked FROM l) AS locked,(SELECT count(*)::int FROM w) AS hours,
    extract(epoch FROM clock_timestamp() - statement_timestamp()) * 1000 AS read_ms`;

export type CaptureBlockOutcome =
  | { kind: "done"; hours: number; readMs: number }
  /** Another session kept the pool through every retry. */
  | { kind: "lock" }
  /** A single hour's count ran out its own limit; `readMs` is that limit. */
  | { kind: "slow"; readMs: number }
  /** A block of more than one hour ran out its own limit: it is counted hour by hour from now on. */
  | { kind: "split"; readMs: number }
  /** The session's budget cut the count short of its own limit. */
  | { kind: "budget" };

const hourMs = 3_600_000;

/**
 * The hours [from, to) of one pool, counted in one short transaction, under at most its limit and
 * the session's rest. A block whose own limit runs out is never retried whole: the caller counts
 * its hours one by one, and only a single hour past its limit is slow.
 */
export async function countCaptureBlock(
  db: HistoryDatabase,
  pool: string,
  from: string,
  to: string,
  left: () => number,
  limitMs = captureHoursCountLimitMs,
): Promise<CaptureBlockOutcome> {
  const pattern = poolUsernamePattern(pool);
  const source = await digest(homeHistorySource);
  const single = Date.parse(to) - Date.parse(from) <= hourMs;
  for (let refused = 0; ;) {
    const limit = Math.max(captureHoursMinCountMs, Math.min(limitMs, Math.floor(left())));
    await db.query("BEGIN");
    try {
      await db.query("SELECT set_config('statement_timeout',$1,true)", [`${limit}ms`]);
      const row = (await db.query(countBlockStatement, [pool, from, to, pattern, source])).rows[0];
      if (row?.locked !== true) {
        await db.query("ROLLBACK");
        if (++refused >= refusalsAllowed || left() <= 0) return { kind: "lock" };
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      await db.query("COMMIT");
      return { kind: "done", hours: Number(row.hours), readMs: Number(row.read_ms ?? 0) };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      if (postgresCode(error) !== "57014") throw error;
      if (limit < limitMs) return { kind: "budget" };
      return single ? { kind: "slow", readMs: limit } : { kind: "split", readMs: limit };
    }
  }
}

/** One hour's count: a block of one hour. */
export const countCaptureHour = (
  db: HistoryDatabase,
  pool: string,
  hour: string,
  left: () => number,
  limitMs = captureHoursCountLimitMs,
) =>
  countCaptureBlock(
    db,
    pool,
    hour,
    new Date(Date.parse(hour) + hourMs).toISOString(),
    left,
    limitMs,
  );
