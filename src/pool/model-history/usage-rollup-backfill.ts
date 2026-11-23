import { digest } from "../backend-users.ts";
import { HistoryInputError, historyObject, invalidHistory } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import { maxSummaryRollupGroups } from "./summary-rollup-query.ts";
import {
  recomputeUsageRollupHour,
  usageRollupReadLimitMs,
  type UsageRollupSlowPhase,
} from "./usage-rollup-hour.ts";
import { historyUsageRollupVersion } from "./usage-rollup-schema.ts";

export { usageRollupHoldLimitMs, usageRollupReadLimitMs } from "./usage-rollup-hour.ts";

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
 * hour slower three times in a row is set aside and tried once more after the pool's other hours;
 * still slow then, it stops the call, naming it.
 */
export const usageRollupHourLimitMs = 150;

const day = 86_400_000;
const midnight = (at: number) => new Date(Math.floor(at / day) * day).toISOString();

export interface UsageRollupPlan {
  readonly pools: readonly { pool: string; from: string; to: string; days: number }[];
}

/**
 * Each pool's whole UTC days that may hold rows written before the rollup's trigger existed. Reads
 * only the pool-time index's ends and the rollup's own small tables; never a usage row's values.
 */
export async function planUsageRollup(db: HistoryDatabase) {
  const ready = await db.query("SELECT 1 FROM basalt_model_history_migrations WHERE name=$1", [
    historyUsageRollupVersion,
  ]);
  if (!ready.rows.length) throw new Error("The usage rollup migration is not applied");
  const pools = (
    await db.query(`WITH RECURSIVE p AS (
        SELECT min(pool) AS pool FROM basalt_model_requests
        UNION ALL SELECT (SELECT min(r.pool) FROM basalt_model_requests r WHERE r.pool > p.pool)
        FROM p WHERE p.pool IS NOT NULL
      ) SELECT p.pool,
        (SELECT min(r.timestamp) FROM basalt_model_requests r WHERE r.pool=p.pool) AS first_at,
        (SELECT max(r.timestamp) FROM basalt_model_requests r WHERE r.pool=p.pool) AS last_at,
        EXISTS (SELECT 1 FROM basalt_model_usage_ready d WHERE d.pool=p.pool) AS ready,
        (SELECT count(*) FROM basalt_model_usage_hours h WHERE h.pool=p.pool)::int AS hours
      FROM p WHERE p.pool IS NOT NULL ORDER BY p.pool`)
  ).rows;
  const plan: UsageRollupPlan = {
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
  return {
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
 * marked ready only after its last hour. An hour too slow three times in a row is deferred and the
 * pool goes on; once its other hours are done, each deferred hour gets one more full try, so an hour
 * that was only cold finishes in the same call. Returns counts only.
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
  readLimitMs = usageRollupReadLimitMs,
) {
  const started = now();
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
  let slow: { phase: UsageRollupSlowPhase; readMs: number } | undefined;
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
        WHERE NOT EXISTS (SELECT 1 FROM basalt_model_usage_hours d WHERE d.pool=$1 AND d.hour=h.at)
        ORDER BY h.at`,
        [item.pool, item.from, item.to],
      )
    ).rows.map((row) => new Date(row.at as string | Date).toISOString());
    let recomputedHours = 0,
      groups = 0;
    const slowHours = new Map<string, { phase: UsageRollupSlowPhase; readMs: number }>();
    /** One hour's full try; "end" once the call must stop, with `stop` saying why. */
    const attempt = async (at: string): Promise<"next" | "slow" | "end"> => {
      if (stopped() || now() - started >= budgetMs) {
        stop = "budget";
        return "end";
      }
      // Every call gets one hour through; the hour that crosses the budget is its last.
      if (callHours > 0 && (await walWritten()) >= walBudgetBytes) {
        stop = "wal";
        return "end";
      }
      const hour = await recomputeUsageRollupHour(
        db,
        item.pool,
        at,
        { hourLimitMs, readLimitMs },
        now,
      );
      maxHoldMs = Math.max(maxHoldMs, hour.heldMs);
      if (hour.kind === "lock") {
        stop = "lock";
        return "end";
      }
      if (hour.kind === "slow") {
        slowHours.set(at, { phase: hour.phase, readMs: hour.readMs });
        return "slow";
      }
      if (hour.kind === "done" || hour.committed) {
        groups += hour.groups;
        recomputedHours++;
        callHours++;
      }
      if (hour.kind === "slow_hold") {
        stop = "slow_hold";
        slowHour = at;
        return "end";
      }
      return "next";
    };
    let ended = false;
    const deferred: string[] = [];
    for (const at of pending) {
      const next = await attempt(at);
      if (next === "end") {
        ended = true;
        break;
      }
      if (next === "slow") deferred.push(at);
    }
    const stillSlow: string[] = [];
    for (const at of ended ? [] : deferred) {
      const next = await attempt(at);
      if (next === "end") {
        ended = true;
        break;
      }
      if (next === "slow") stillSlow.push(at);
    }
    // Only hours slow on both tries are left: the call stops on the first of them, naming it.
    if (!ended && stillSlow.length) {
      stop = "slow_hour";
      slowHour = stillSlow[0]!;
      slow = slowHours.get(slowHour);
    }
    const remainingHours = pending.length - recomputedHours;
    let groupsInWindow: number | undefined;
    if (remainingHours === 0) {
      await db.query(
        `INSERT INTO basalt_model_usage_ready (pool,through) VALUES ($1,$2::timestamptz)
        ON CONFLICT (pool) DO NOTHING`,
        [item.pool, item.to],
      );
      // The summary refuses a window holding more groups than its bound; say so at the end.
      groupsInWindow = Number(
        (
          await db.query(
            `SELECT count(*)::int AS n FROM (SELECT 1 FROM basalt_model_usage_hourly
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
    // Where the named slow hour was cancelled, and how long its last warming read ran.
    ...(slow ? { slowPhase: slow.phase, slowReadMs: Math.round(slow.readMs * 10) / 10 } : {}),
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
