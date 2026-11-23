import { digest } from "../backend-users.ts";
import { HistoryInputError, historyObject, invalidHistory } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import { maxSummaryRollupGroups } from "./summary-rollup-query.ts";
import { usageRollupLockClass } from "./usage-rollup-schema.ts";
import {
  activeUsageRollupTarget,
  isUsageRollupTarget,
  usageRollupTargets,
  type UsageRollupTarget,
} from "./usage-rollup-targets.ts";

export const historyUsageRollupPath = "/model-history/usage-rollup";
export const historyUsageRollupBackfillVersion = "usage_rollup_backfill_v3";
/**
 * The most write-ahead log the database may write during one backfill call before it stops at the
 * next hour boundary. It counts every writer's WAL, not only the backfill's, so concurrent writes
 * slow the backfill; a call can pass it by its last hour's WAL and whatever else wrote meanwhile.
 * It is checked before every hour after the call's first, whichever pool the hour belongs to.
 */
export const usageRollupWalPerCall = 32 * 1024 * 1024;
/**
 * How long one hour's recompute may run once the backfill holds the pool. There is no raise: an
 * hour slower three times in a row stops the run, naming it, for a person.
 */
export const usageRollupHourLimitMs = 150;
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

const day = 86_400_000;
const midnight = (at: number) => new Date(Math.floor(at / day) * day).toISOString();

export interface UsageRollupPlan {
  /** The rollup the plan recomputes; a plan without one predates v16 and means v15. */
  readonly rollup?: UsageRollupTarget;
  readonly pools: readonly { pool: string; from: string; to: string; days: number }[];
}

/**
 * Each pool's whole UTC days that may hold rows written before the rollup's trigger existed. Reads
 * only the pool-time index's ends and the rollup's own small tables; never a usage row's values.
 * Without a target it plans the newest rollup this database applied.
 */
export async function planUsageRollup(db: HistoryDatabase, target?: UsageRollupTarget) {
  const active = await activeUsageRollupTarget(db);
  const rollup = target ?? active;
  if (!rollup || (rollup === "v16" && active !== "v16"))
    throw new Error("The usage rollup migration is not applied");
  const names = usageRollupTargets[rollup];
  const pools = (
    await db.query(`WITH RECURSIVE p AS (
        SELECT min(pool) AS pool FROM basalt_model_requests
        UNION ALL SELECT (SELECT min(r.pool) FROM basalt_model_requests r WHERE r.pool > p.pool)
        FROM p WHERE p.pool IS NOT NULL
      ) SELECT p.pool,
        (SELECT min(r.timestamp) FROM basalt_model_requests r WHERE r.pool=p.pool) AS first_at,
        (SELECT max(r.timestamp) FROM basalt_model_requests r WHERE r.pool=p.pool) AS last_at,
        EXISTS (SELECT 1 FROM ${names.ready} d WHERE d.pool=p.pool) AS ready,
        (SELECT count(*) FROM ${names.hours} h WHERE h.pool=p.pool)::int AS hours
      FROM p WHERE p.pool IS NOT NULL ORDER BY p.pool`)
  ).rows;
  const plan: UsageRollupPlan = {
    rollup,
    pools: pools
      .filter((row) => row.ready !== true)
      .map((row) => {
        // The indexed time is rounded to microseconds; start a day early so no first row is missed.
        const from = midnight(new Date(row.first_at as string | Date).getTime() - day);
        const to = midnight(new Date(row.last_at as string | Date).getTime() + day);
        return {
          pool: String(row.pool),
          from,
          to,
          days: (Date.parse(to) - Date.parse(from)) / day,
        };
      }),
  };
  return {
    plan,
    digest: await digest(JSON.stringify(plan)),
    ready: pools.filter((row) => row.ready === true).map((row) => String(row.pool)),
    recomputedHours: Object.fromEntries(pools.map((row) => [String(row.pool), Number(row.hours)])),
  };
}

export function approvedUsageRollupPlan(raw: unknown): UsageRollupPlan {
  const value = historyObject(raw);
  if (!Array.isArray(value.pools) || value.pools.length > 1_000) return invalidHistory();
  if (value.rollup !== undefined && !isUsageRollupTarget(value.rollup)) return invalidHistory();
  return {
    ...(value.rollup === undefined ? {} : { rollup: value.rollup }),
    pools: value.pools.map((item) => {
      const pool = historyObject(item);
      const from = String(pool.from),
        to = String(pool.to);
      if (
        typeof pool.pool !== "string" ||
        !/^[0-9a-f]{16}$/.test(pool.pool) ||
        midnight(Date.parse(from)) !== from ||
        midnight(Date.parse(to)) !== to ||
        to <= from ||
        pool.days !== (Date.parse(to) - Date.parse(from)) / day
      )
        return invalidHistory();
      return { pool: pool.pool, from, to, days: pool.days as number };
    }),
  };
}

/**
 * Recomputes the plan's hours, one hour per transaction, until the time budget runs out. An hour
 * already recomputed is skipped, so a stopped or failed run resumes where it left off; a pool is
 * marked ready only after its last hour. Returns counts only.
 */
export async function runUsageRollup(
  db: HistoryDatabase,
  plan: UsageRollupPlan,
  budgetMs = 12_000,
  now: () => number = () => performance.now(),
  walBudgetBytes = usageRollupWalPerCall,
  hourLimitMs = usageRollupHourLimitMs,
  /** True once the caller must end: the call stops at the next hour boundary, like its budget. */
  stopped: () => boolean = () => false,
) {
  const started = now();
  const names = usageRollupTargets[plan.rollup ?? "v15"];
  // The write-ahead log this call adds, measured on the server before every hour it starts. The
  // insert position counts WAL a commit that skipped the flush has not written out yet.
  const walStart = String(
    (await db.query("SELECT pg_current_wal_insert_lsn()::text AS lsn")).rows[0]?.lsn ?? "",
  );
  const walWritten = async () =>
    Number(
      (
        await db.query(
          "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text AS bytes",
          [walStart],
        )
      ).rows[0]?.bytes ?? 0,
    );
  let stop: "budget" | "wal" | "lock" | "slow_hour" | "slow_hold" | undefined;
  let slowHour: string | undefined;
  let maxHoldMs = 0;
  const pools: {
    pool: string;
    recomputedHours: number;
    groups: number;
    remainingHours: number;
    groupsInWindow?: number;
    groupBound?: number;
  }[] = [];
  let complete = true;
  // Hours this call recomputed across every pool: only the call's first hour skips the WAL check.
  let callHours = 0;
  for (const item of plan.pools) {
    const pending = (
      await db.query(
        `SELECT h.at FROM generate_series($2::timestamptz,$3::timestamptz-interval '1 hour',
          interval '1 hour') AS h(at)
        WHERE NOT EXISTS (SELECT 1 FROM ${names.hours} d WHERE d.pool=$1 AND d.hour=h.at)
        ORDER BY h.at`,
        [item.pool, item.from, item.to],
      )
    ).rows.map((row) => new Date(row.at as string | Date).toISOString());
    let recomputedHours = 0,
      groups = 0;
    hours: for (const at of pending) {
      if (stopped() || now() - started >= budgetMs) {
        stop = "budget";
        break;
      }
      // Every call gets one hour through; the hour that crosses the budget is its last.
      if (callHours > 0 && (await walWritten()) >= walBudgetBytes) {
        stop = "wal";
        break;
      }
      // A cold cache can make one attempt slow; three in a row mean the hour itself is too dense.
      // A writer holding the pool makes the backfill step aside; five refusals in a row stop it.
      let slowAttempts = 0,
        refused = 0;
      for (;;) {
        let holdStarted: number | undefined;
        await db.query("BEGIN");
        try {
          // The hour's recompute and its marker commit together, so a commit that skips the WAL
          // flush can lose only whole hours to a crash, and the next run recomputes them.
          await db.query(
            `SELECT set_config('statement_timeout',$1,true),set_config('TimeZone','UTC',true),
              set_config('synchronous_commit','off',true)`,
            [`${hourLimitMs}ms`],
          );
          // A try-lock never queues, so no writer ever waits behind a backfill that is itself
          // waiting. Taking it in the recompute's own statement leaves one round trip in the hold.
          // Each fenced subquery runs before the one around it, so the server's times bracket the
          // hold from the lock to the end of the recompute.
          holdStarted = now();
          const written = await db.query(
            `SELECT r.groups, extract(epoch FROM clock_timestamp() - r.locked_at) * 1000 AS held_ms
            FROM (
              SELECT l.locked_at, CASE WHEN l.locked THEN ${names.recompute}(
                $1,$2::timestamptz,$2::timestamptz + interval '1 hour') END AS groups
              FROM (
                SELECT pg_try_advisory_xact_lock(${usageRollupLockClass},hashtext($1)) AS locked,
                  clock_timestamp() AS locked_at
                OFFSET 0
              ) l
              OFFSET 0
            ) r`,
            [item.pool, at],
          );
          if (written.rows[0]?.groups === null || written.rows[0]?.groups === undefined) {
            await db.query("ROLLBACK");
            if (++refused >= 5) {
              stop = "lock";
              break hours;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
            continue;
          }
          const commitStarted = now();
          await db.query("COMMIT");
          const held = Number(written.rows[0].held_ms) + (now() - commitStarted);
          maxHoldMs = Math.max(maxHoldMs, held);
          groups += Number(written.rows[0].groups);
          recomputedHours++;
          callHours++;
          if (held > usageRollupHoldLimitMs) {
            stop = "slow_hold";
            slowHour = at;
            break hours;
          }
          break;
        } catch (error) {
          const failedAt = now();
          await db.query("ROLLBACK").catch(() => {});
          const code = postgresCode(error);
          // A cancelled recompute holds the pool until Postgres acts on the cancel, which can be
          // well past the hour limit; that hold counts like any other.
          if (holdStarted !== undefined) {
            const held = failedAt - holdStarted;
            maxHoldMs = Math.max(maxHoldMs, held);
            if (code === "57014" && held > usageRollupHoldLimitMs) {
              stop = "slow_hold";
              slowHour = at;
              break hours;
            }
          }
          if (code === "57014" && ++slowAttempts < 3) continue;
          if (code === "57014") {
            stop = "slow_hour";
            slowHour = at;
            break hours;
          }
          throw error;
        }
      }
    }
    const remainingHours = pending.length - recomputedHours;
    let groupsInWindow: number | undefined;
    if (remainingHours === 0) {
      await db.query(
        `INSERT INTO ${names.ready} (pool,through) VALUES ($1,$2::timestamptz)
        ON CONFLICT (pool) DO NOTHING`,
        [item.pool, item.to],
      );
      // The summary refuses a window holding more groups than its bound; say so at the end.
      groupsInWindow = Number(
        (
          await db.query(
            `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${names.hourly}
              WHERE pool=$1 AND hour >= now() - interval '14 weeks' LIMIT $2) g`,
            [item.pool, maxSummaryRollupGroups + 1],
          )
        ).rows[0]?.n ?? 0,
      );
    } else complete = false;
    pools.push({
      pool: item.pool,
      recomputedHours,
      groups,
      remainingHours,
      ...(groupsInWindow === undefined
        ? {}
        : { groupsInWindow, groupBound: maxSummaryRollupGroups }),
    });
    if (!complete) break;
    // A hold past the limit ends the call even when it finished its pool, so no later pool's
    // writers wait behind the next one; the call reports progress, and the run stops for a person.
    if (stop === "slow_hold") {
      complete = false;
      break;
    }
  }
  return {
    status: complete ? ("complete" as const) : ("progress" as const),
    ...(complete ? {} : { stopped: stop ?? "budget" }),
    ...(slowHour ? { slowHour } : {}),
    maxHoldMs: Math.round(maxHoldMs),
    walBytes: await walWritten(),
    pools,
  };
}

export async function handleUsageRollupOperation(
  request: Request,
  db: HistoryDatabase,
  automatic?: () => Promise<unknown>,
) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method === "GET") {
    const planned = await planUsageRollup(db);
    // The apply measures its write-ahead log; a role that cannot read it fails here, before writes.
    await db.query("SELECT pg_current_wal_insert_lsn()");
    return Response.json(
      {
        status: "dry-run",
        version: historyUsageRollupBackfillVersion,
        ...planned,
        // The manual way to look must not depend on the object's state answering.
        ...(automatic ? { automatic: await automatic().catch(() => null) } : {}),
        writes: false,
      },
      { headers },
    );
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const approval = historyObject(await request.json());
  if (approval.go !== true) return new Response(null, { status: 400 });
  let plan: UsageRollupPlan;
  try {
    plan = approvedUsageRollupPlan(approval.plan);
  } catch (error) {
    if (error instanceof HistoryInputError) return new Response(null, { status: 400 });
    throw error;
  }
  if (approval.digest !== (await digest(JSON.stringify(plan))))
    return new Response(null, { status: 409 });
  const walBudget = approval.walBudgetBytes ?? usageRollupWalPerCall;
  if (
    typeof walBudget !== "number" ||
    !Number.isSafeInteger(walBudget) ||
    walBudget < 1 ||
    walBudget > usageRollupWalPerCall
  )
    return new Response(null, { status: 400 });
  if (approval.hourLimitMs !== undefined) return new Response(null, { status: 400 });
  const result = await runUsageRollup(db, plan, 12_000, undefined, walBudget);
  return Response.json(
    { ...result, version: historyUsageRollupBackfillVersion, digest: approval.digest },
    { headers },
  );
}
