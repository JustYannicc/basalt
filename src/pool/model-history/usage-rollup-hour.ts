import type { HistoryDatabase } from "./schema.ts";
import {
  usageRollupBaseRows,
  usageRollupLockClass,
  usageRollupProjection,
} from "./usage-rollup-schema.ts";

/**
 * How long the read that warms one hour's rows may run, outside any lock. It holds no writer, so
 * it can take far longer than the recompute; it only has to stay well inside one session.
 */
export const usageRollupReadLimitMs = 2_000;
/**
 * The longest the backfill may hold the pool. A committed hour's hold is measured on the server
 * from taking the lock to the end of the recompute, plus the commit's round trip timed by the
 * caller. Postgres releases the lock when a cancelled recompute fails, so a cancelled attempt's
 * hold is timed by the caller from sending the statement until its error arrives, which includes
 * both legs of that round trip. The hold is normally the recompute, one round trip and a commit
 * that does not wait for the WAL flush; a hold over this ends the call, naming the hour, and the
 * run stops there for a person. It bounds how often a hold runs long, not how long one lasts on a
 * stalled disk.
 */
export const usageRollupHoldLimitMs = 350;

/** Where a slow attempt was cancelled: warming the rows, or recomputing them under the lock. */
export type UsageRollupSlowPhase = "read" | "recompute";

export type UsageRollupHourOutcome =
  /** The hour committed; `heldMs` is the longest hold of any of its attempts. */
  | { kind: "done"; groups: number; heldMs: number }
  /** A hold past the limit; a committed one still counts its hour. */
  | { kind: "slow_hold"; committed: boolean; groups: number; heldMs: number }
  /** Three attempts in a row were cancelled; `readMs` is the last warming read's server time. */
  | { kind: "slow"; phase: UsageRollupSlowPhase; readMs: number; heldMs: number }
  /** Five lock refusals in a row: writers hold the pool. */
  | { kind: "lock"; heldMs: number };

/**
 * The Postgres error code behind a failed statement. The bounded session the operator runs in
 * rethrows Postgres's own statement cancel as a history timeout carrying the driver's error as its
 * cause, so a code read only from the error itself would never see a cancel there.
 */
function postgresCode(error: unknown): unknown {
  const code = (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value ? value.code : undefined;
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return code(error) === "57014" || code(cause) === undefined ? code(error) : code(cause);
}

/**
 * The recompute's own aggregate of one pool-hour, computed and discarded: no write and no lock, so
 * no writer ever waits for it. It reads the recompute's pages into the cache, and as its last act
 * sets the statement limit the next statement, the locked recompute, runs under; a statement keeps
 * the limit it started with. $1 pool, $2 hour, $3 the recompute's limit.
 */
const prewarm = `SELECT p.groups, p.requests,
    extract(epoch FROM clock_timestamp() - statement_timestamp()) * 1000 AS read_ms,
    set_config('statement_timeout',$3,true) AS hour_limit
  FROM (
    SELECT count(*)::int AS groups, coalesce(sum(g.requests),0)::text AS requests
    FROM (${usageRollupProjection(
      usageRollupBaseRows("$1", "$2::timestamptz", "($2::timestamptz + interval '1 hour')"),
    )}) g
    OFFSET 0
  ) p`;

/**
 * The prewarm alone, in its caller's transaction, leaving the caller's statement limit as it was:
 * the groups and requests the recompute of that hour will write.
 */
export async function prewarmUsageRollupHour(db: HistoryDatabase, pool: string, at: string) {
  const limit = (await db.query("SELECT current_setting('statement_timeout') AS v")).rows[0]?.v;
  const row = (await db.query(prewarm, [pool, at, String(limit)])).rows[0];
  return { groups: Number(row?.groups), requests: String(row?.requests), readMs: row?.read_ms };
}

/**
 * One hour's try: each attempt warms the hour's rows outside the lock, then takes the pool with a
 * try-lock and recomputes the hour within the hour limit, in one transaction. A cold cache can make
 * one attempt slow; three in a row mean the hour itself is too dense for now. A writer holding the
 * pool makes the backfill step aside; five refusals in a row end the try.
 */
export async function recomputeUsageRollupHour(
  db: HistoryDatabase,
  pool: string,
  at: string,
  limits: { hourLimitMs: number; readLimitMs: number },
  now: () => number,
): Promise<UsageRollupHourOutcome> {
  let slowAttempts = 0,
    refused = 0,
    maxHoldMs = 0,
    readMs = 0;
  // A refusal comes right after a read that finished, so its retry starts on warm pages.
  let warm = true;
  for (;;) {
    let holdStarted: number | undefined;
    await db.query("BEGIN");
    try {
      // The hour's recompute and its marker commit together, so a commit that skips the WAL
      // flush can lose only whole hours to a crash, and the next run recomputes them.
      await db.query(
        `SELECT set_config('statement_timeout',$1,true),set_config('TimeZone','UTC',true),
          set_config('synchronous_commit','off',true)`,
        [`${warm ? limits.readLimitMs : limits.hourLimitMs}ms`],
      );
      if (warm) {
        const read = await db.query(prewarm, [pool, at, `${limits.hourLimitMs}ms`]);
        readMs = Number(read.rows[0]?.read_ms ?? 0);
      }
      // A try-lock never queues, so no writer ever waits behind a backfill that is itself
      // waiting. Taking it in the recompute's own statement leaves one round trip in the hold.
      // Each fenced subquery runs before the one around it, so the server's times bracket the
      // hold from the lock to the end of the recompute.
      holdStarted = now();
      const written = await db.query(
        `SELECT r.groups, extract(epoch FROM clock_timestamp() - r.locked_at) * 1000 AS held_ms
        FROM (
          SELECT l.locked_at, CASE WHEN l.locked THEN basalt_model_usage_recompute(
            $1,$2::timestamptz,$2::timestamptz + interval '1 hour') END AS groups
          FROM (
            SELECT pg_try_advisory_xact_lock(${usageRollupLockClass},hashtext($1)) AS locked,
              clock_timestamp() AS locked_at
            OFFSET 0
          ) l
          OFFSET 0
        ) r`,
        [pool, at],
      );
      if (written.rows[0]?.groups === null || written.rows[0]?.groups === undefined) {
        await db.query("ROLLBACK");
        if (++refused >= 5) return { kind: "lock", heldMs: maxHoldMs };
        warm = false;
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const commitStarted = now();
      await db.query("COMMIT");
      const held = Number(written.rows[0].held_ms) + (now() - commitStarted);
      maxHoldMs = Math.max(maxHoldMs, held);
      const groups = Number(written.rows[0].groups);
      return held > usageRollupHoldLimitMs
        ? { kind: "slow_hold", committed: true, groups, heldMs: maxHoldMs }
        : { kind: "done", groups, heldMs: maxHoldMs };
    } catch (error) {
      const failedAt = now();
      await db.query("ROLLBACK").catch(() => {});
      const code = postgresCode(error);
      // A cancelled recompute holds the pool until Postgres acts on the cancel, which can be
      // well past the hour limit; that hold counts like any other. A cancelled read held nothing.
      if (holdStarted !== undefined) {
        const held = failedAt - holdStarted;
        maxHoldMs = Math.max(maxHoldMs, held);
        if (code === "57014" && held > usageRollupHoldLimitMs)
          return { kind: "slow_hold", committed: false, groups: 0, heldMs: maxHoldMs };
      }
      if (code !== "57014") throw error;
      const phase: UsageRollupSlowPhase = holdStarted === undefined ? "read" : "recompute";
      if (phase === "read") readMs = limits.readLimitMs;
      // Pages a cancelled read reached stay cached, so the next attempt's read gets further.
      warm = true;
      if (++slowAttempts >= 3) return { kind: "slow", phase, readMs, heldMs: maxHoldMs };
    }
  }
}
