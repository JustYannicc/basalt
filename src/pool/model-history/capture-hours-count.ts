import type { HistoryDatabase } from "./schema.ts";
import { captureHoursLockClass } from "./capture-hours-schema.ts";
import { poolUsageRows, poolUsernamePattern, uncaptured } from "./capture-population.ts";
import { homeHistorySource } from "./home.ts";
import { digest } from "../backend-users.ts";
import { postgresCode } from "./usage-rollup-apply.ts";

/** How long one hour's count may run; past it the hour is slow. */
export const captureHoursCountLimitMs = 1_000;
/** The shortest a count is given: one the session's budget cuts shorter is a budget stop. */
export const captureHoursMinCountMs = 50;
/** Another session holding the pool makes the count step aside; this many refusals end the hour. */
const refusalsAllowed = 5;

/**
 * One statement: try-locks the pool, and only if it holds it counts the hour's Home usage rows of
 * the pool's users through Home's usage time index, probes each one's request by its key as the
 * summary's per-row check does, and stores both counts with this transaction's time. A refused
 * lock reads and writes nothing. $1 pool, $2 hour, $3 username pattern, $4 Home source.
 */
export const countHourStatement = `WITH l AS MATERIALIZED (
    SELECT pg_try_advisory_xact_lock(${captureHoursLockClass},hashtext($1::text)) AS locked
  ), n AS MATERIALIZED (
    SELECT count(*)::int AS usage_requests,
      (count(*) FILTER (WHERE ${uncaptured("$1::varchar", "$4")}))::int AS uncaptured_requests
    FROM ${poolUsageRows(
      "$3::text",
      "u.timestamp >= $2::timestamptz AND u.timestamp < $2::timestamptz + interval '1 hour'",
    )}
      AND (SELECT locked FROM l)
  ), w AS (
    INSERT INTO basalt_model_capture_hours AS s
      (pool,hour,usage_requests,uncaptured_requests,checked_at)
    SELECT $1::varchar,$2::timestamptz,n.usage_requests,n.uncaptured_requests,
      transaction_timestamp() FROM n
    WHERE (SELECT locked FROM l)
    ON CONFLICT (pool,hour) DO UPDATE
      SET usage_requests=EXCLUDED.usage_requests,
        uncaptured_requests=EXCLUDED.uncaptured_requests,checked_at=EXCLUDED.checked_at
    RETURNING s.usage_requests, s.uncaptured_requests
  )
  SELECT (SELECT locked FROM l) AS locked,(SELECT usage_requests FROM w) AS usage_requests,
    (SELECT uncaptured_requests FROM w) AS uncaptured_requests,
    extract(epoch FROM clock_timestamp() - statement_timestamp()) * 1000 AS read_ms`;

export type CaptureHourOutcome =
  | { kind: "done"; usageRequests: number; uncapturedRequests: number; readMs: number }
  /** Another session kept the pool through every retry. */
  | { kind: "lock" }
  /** The count ran out its own limit; `readMs` is that limit. */
  | { kind: "slow"; readMs: number }
  /** The session's budget cut the count short of its own limit. */
  | { kind: "budget" };

/** One hour's count in its own short transaction, under at most its limit and the session's rest. */
export async function countCaptureHour(
  db: HistoryDatabase,
  pool: string,
  hour: string,
  left: () => number,
  limitMs = captureHoursCountLimitMs,
): Promise<CaptureHourOutcome> {
  const pattern = poolUsernamePattern(pool);
  const source = await digest(homeHistorySource);
  for (let refused = 0; ;) {
    const limit = Math.max(captureHoursMinCountMs, Math.min(limitMs, Math.floor(left())));
    await db.query("BEGIN");
    try {
      await db.query("SELECT set_config('statement_timeout',$1,true)", [`${limit}ms`]);
      const row = (await db.query(countHourStatement, [pool, hour, pattern, source])).rows[0];
      if (row?.locked !== true) {
        await db.query("ROLLBACK");
        if (++refused >= refusalsAllowed || left() <= 0) return { kind: "lock" };
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      await db.query("COMMIT");
      return {
        kind: "done",
        usageRequests: Number(row.usage_requests),
        uncapturedRequests: Number(row.uncaptured_requests),
        readMs: Number(row.read_ms ?? 0),
      };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      if (postgresCode(error) !== "57014") throw error;
      return limit < limitMs ? { kind: "budget" } : { kind: "slow", readMs: limit };
    }
  }
}
