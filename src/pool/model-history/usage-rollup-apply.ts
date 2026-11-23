import type { HistoryDatabase } from "./schema.ts";
import { usagePeopleRollupNames } from "./usage-rollup-people-schema.ts";
import { usageRollupBaseRows, usageRollupLockClass } from "./usage-rollup-schema.ts";
import { usageRollupTargets } from "./usage-rollup-targets.ts";

/**
 * How long the v16 backfill's read of one hour may run, outside any lock. It holds no writer, so it
 * may take far longer than the apply; past this the hour is slow, and only then.
 */
export const usageRollupReadLimitMs = 5_000;
/** The shortest a read is given: one the call's budget cuts shorter than its limit is a budget stop. */
export const usageRollupMinReadMs = 50;
/** Round trips and the commit after a read, kept out of the read's share of the budget. */
const marginMs = 50;
/** A writer holding the pool makes the apply step aside; this many refusals in a row end the hour. */
const refusalsAllowed = 5;
/** Rows landing in the hour between its read and its apply; this many in a row end the hour. */
const changesAllowed = 5;

/**
 * The Postgres error code behind a failed statement. The bounded session the operator runs in
 * rethrows Postgres's own statement cancel as a history timeout carrying the driver's error as its
 * cause, so a code read only from the error itself would never see a cancel there.
 */
export function postgresCode(error: unknown): unknown {
  const code = (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value ? value.code : undefined;
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return code(error) === "57014" || code(cause) === undefined ? code(error) : code(cause);
}

const v16 = usageRollupTargets.v16;

/**
 * One read-only statement, so one snapshot: the hour's groups as the v16 recompute would write
 * them, and the request count the v16 trigger kept for that hour. It takes no advisory lock, and as
 * its last act sets the limit the apply after it runs under. $1 pool, $2 hour, $3 apply limit.
 */
const readStatement = `SELECT p.rows::text AS rows, p.seen::text AS seen,
    extract(epoch FROM clock_timestamp() - statement_timestamp()) * 1000 AS read_ms,
    set_config('statement_timeout',$3,true) AS apply_limit
  FROM (
    SELECT coalesce(jsonb_agg(to_jsonb(g)),'[]'::jsonb) AS rows,
      (SELECT coalesce(sum(h.requests),0) FROM ${v16.hourly} h
        WHERE h.pool=$1 AND h.hour=$2::timestamptz) AS seen
    FROM (${v16.projection(
      usageRollupBaseRows("$1", "$2::timestamptz", "($2::timestamptz + interval '1 hour')"),
    )}) g
    OFFSET 0
  ) p`;

/**
 * The try-lock never queues, so no writer ever waits behind a backfill that is itself waiting, and
 * the apply runs only once it holds the pool. Each fenced subquery runs before the one around it, so
 * the server's times bracket the hold from the lock to the end of the apply. The rows are bound as
 * a parameter, so parsing them happens before the lock.
 */
const applyStatement = `SELECT r.groups, extract(epoch FROM clock_timestamp() - r.locked_at) * 1000 AS held_ms
  FROM (
    SELECT l.locked_at, CASE WHEN l.locked THEN ${usagePeopleRollupNames.apply}(
      $1,$2::timestamptz,$3::bigint,$4::jsonb) END AS groups
    FROM (
      SELECT pg_try_advisory_xact_lock(${usageRollupLockClass},hashtext($1)) AS locked,
        clock_timestamp() AS locked_at
      OFFSET 0
    ) l
    OFFSET 0
  ) r`;

/** The read alone, in its caller's transaction: the groups and count the apply would compare. */
export async function readUsagePeopleRollupHour(db: HistoryDatabase, pool: string, at: string) {
  const limit = (await db.query("SELECT current_setting('statement_timeout') AS v")).rows[0]?.v;
  const row = (await db.query(readStatement, [pool, at, String(limit)])).rows[0];
  return { rows: JSON.parse(String(row?.rows)) as unknown[], seen: String(row?.seen) };
}

export type UsageRollupApplyOutcome =
  /** The hour committed; `heldMs` is the longest hold of any attempt. */
  | { kind: "done"; groups: number; heldMs: number }
  /** A hold past the limit; a committed one still counts its hour. */
  | { kind: "slow_hold"; committed: boolean; groups: number; heldMs: number }
  /** The read ran out its own limit, not the call's budget; `readMs` is that limit. */
  | { kind: "slow_read"; readMs: number; heldMs: number }
  /** Writers kept the pool (`lock`), or rows kept landing in the hour (`changing`). */
  | { kind: "lock" | "changing"; readMs: number; heldMs: number }
  /** The call's budget or a handover ended the hour before it committed. */
  | { kind: "budget"; heldMs: number };

/**
 * One v16 hour: read its groups and count outside the lock, then apply them in a short transaction
 * that holds the pool only for the compare and the write. A refusal retries the apply with the same
 * read; a changed hour reads again. The hour's first attempt always starts; a later one only while
 * the call has budget left and no handover started.
 */
export async function applyUsagePeopleRollupHour(
  db: HistoryDatabase,
  pool: string,
  at: string,
  limits: { applyLimitMs: number; readLimitMs: number; holdLimitMs: number },
  now: () => number,
  budget: { left: () => number; stopped: () => boolean },
): Promise<UsageRollupApplyOutcome> {
  let refused = 0,
    changed = 0,
    maxHoldMs = 0,
    readMs = 0;
  let read: { rows: string; seen: string } | undefined;
  for (let attempt = 0; ; attempt++) {
    // A draining handover starts no read: its lock on the table could hold a migration's ALTER.
    if (attempt > 0 && (budget.stopped() || budget.left() <= 0))
      return { kind: "budget", heldMs: maxHoldMs };
    const reading = Math.min(
      limits.readLimitMs,
      Math.max(usageRollupMinReadMs, Math.floor(budget.left() - limits.applyLimitMs - marginMs)),
    );
    let holdStarted: number | undefined;
    await db.query("BEGIN");
    try {
      // The hour's rows and its marker commit together, so a commit that skips the WAL flush can
      // lose only whole hours to a crash, and the next run applies them again.
      await db.query(
        `SELECT set_config('statement_timeout',$1,true),set_config('TimeZone','UTC',true),
          set_config('synchronous_commit','off',true)`,
        [`${read ? limits.applyLimitMs : reading}ms`],
      );
      if (!read) {
        const row = (await db.query(readStatement, [pool, at, `${limits.applyLimitMs}ms`])).rows[0];
        read = { rows: String(row?.rows), seen: String(row?.seen) };
        readMs = Number(row?.read_ms ?? 0);
      }
      holdStarted = now();
      const written = await db.query(applyStatement, [pool, at, read.seen, read.rows]);
      const groups = written.rows[0]?.groups;
      if (groups === null || groups === undefined) {
        await db.query("ROLLBACK");
        if (++refused >= refusalsAllowed) return { kind: "lock", readMs, heldMs: maxHoldMs };
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (Number(groups) < 0) {
        // It held the pool for the compare only; the rollback ends that hold.
        const rollbackStarted = now();
        await db.query("ROLLBACK");
        const held = Number(written.rows[0]!.held_ms) + (now() - rollbackStarted);
        maxHoldMs = Math.max(maxHoldMs, held);
        read = undefined;
        if (++changed >= changesAllowed) return { kind: "changing", readMs, heldMs: maxHoldMs };
        continue;
      }
      const commitStarted = now();
      await db.query("COMMIT");
      const held = Number(written.rows[0]!.held_ms) + (now() - commitStarted);
      maxHoldMs = Math.max(maxHoldMs, held);
      return held > limits.holdLimitMs
        ? { kind: "slow_hold", committed: true, groups: Number(groups), heldMs: maxHoldMs }
        : { kind: "done", groups: Number(groups), heldMs: maxHoldMs };
    } catch (error) {
      const failedAt = now();
      await db.query("ROLLBACK").catch(() => {});
      const code = postgresCode(error);
      if (holdStarted !== undefined) {
        // A cancelled apply holds the pool until Postgres acts on the cancel; that hold counts
        // like any other. Under the limit it is a failure like any other.
        const held = failedAt - holdStarted;
        maxHoldMs = Math.max(maxHoldMs, held);
        if (code === "57014" && held > limits.holdLimitMs)
          return { kind: "slow_hold", committed: false, groups: 0, heldMs: maxHoldMs };
        throw error;
      }
      if (code !== "57014") throw error;
      // A read the budget cut short of its own limit says nothing about the hour.
      if (reading < limits.readLimitMs) return { kind: "budget", heldMs: maxHoldMs };
      return { kind: "slow_read", readMs: reading, heldMs: maxHoldMs };
    }
  }
}
