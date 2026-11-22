import { digest } from "../backend-users.ts";
import { HistoryInputError, historyObject, invalidHistory } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import { maxSummaryRollupGroups } from "./summary-rollup-query.ts";
import { historyUsageRollupVersion, usageRollupLockClass } from "./usage-rollup-schema.ts";

export const historyUsageRollupPath = "/model-history/usage-rollup";
export const historyUsageRollupBackfillVersion = "usage_rollup_backfill_v2";
/** The most write-ahead log one backfill call may add before it stops at an hour boundary. */
export const usageRollupWalPerCall = 32 * 1024 * 1024;
/**
 * How long one hour's recompute may hold the pool once it has the lock. A writer that arrives then
 * waits at most this, inside its own 500 ms; an approval may raise it to 450 ms, never past it.
 * An hour slower three times in a row stops the run, naming it.
 */
export const usageRollupHourLimitMs = 250;
export const usageRollupHourLimitMaxMs = 450;

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
 * marked ready only after its last hour. Returns counts only.
 */
export async function runUsageRollup(
  db: HistoryDatabase,
  plan: UsageRollupPlan,
  budgetMs = 12_000,
  now: () => number = () => performance.now(),
  walBudgetBytes = usageRollupWalPerCall,
  hourLimitMs = usageRollupHourLimitMs,
) {
  const started = now();
  // The write-ahead log this call adds, measured on the server before every hour it starts.
  const walStart = String(
    (await db.query("SELECT pg_current_wal_lsn()::text AS lsn")).rows[0]?.lsn ?? "",
  );
  const walWritten = async () =>
    Number(
      (
        await db.query("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::text AS bytes", [
          walStart,
        ])
      ).rows[0]?.bytes ?? 0,
    );
  let stop: "budget" | "wal" | "lock" | "slow_hour" | undefined;
  let slowHour: string | undefined;
  const pools: {
    pool: string;
    recomputedHours: number;
    groups: number;
    remainingHours: number;
    groupsInWindow?: number;
    groupBound?: number;
  }[] = [];
  let complete = true;
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
    hours: for (const at of pending) {
      if (now() - started >= budgetMs) {
        stop = "budget";
        break;
      }
      // Every call gets one hour through; the hour that crosses the budget is its last.
      if (recomputedHours > 0 && (await walWritten()) >= walBudgetBytes) {
        stop = "wal";
        break;
      }
      // A cold cache can make one attempt slow; three in a row mean the hour itself is too dense.
      for (let attempt = 1; ; attempt++) {
        await db.query("BEGIN");
        try {
          // The pool's lock first, under a wait below the writers' 500 ms, so a busy pool's writers
          // win; then the hour's own limit applies to the recompute alone.
          await db.query(
            "SELECT set_config('lock_timeout','200ms',true),set_config('statement_timeout','5s',true),set_config('TimeZone','UTC',true)",
          );
          await db.query(`SELECT pg_advisory_xact_lock(${usageRollupLockClass},hashtext($1))`, [
            item.pool,
          ]);
          await db.query("SELECT set_config('statement_timeout',$1,true)", [`${hourLimitMs}ms`]);
          const written = await db.query(
            "SELECT basalt_model_usage_recompute($1,$2::timestamptz,$2::timestamptz + interval '1 hour') AS groups",
            [item.pool, at],
          );
          await db.query("COMMIT");
          groups += Number(written.rows[0]?.groups ?? 0);
          recomputedHours++;
          break;
        } catch (error) {
          await db.query("ROLLBACK").catch(() => {});
          const code =
            typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
          // A writer held the pool's lock; leave this hour for the next call.
          if (code === "55P03") {
            stop = "lock";
            break hours;
          }
          if (code === "57014" && attempt < 3) continue;
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
  }
  return {
    status: complete ? ("complete" as const) : ("progress" as const),
    ...(complete ? {} : { stopped: stop ?? "budget" }),
    ...(slowHour ? { slowHour } : {}),
    walBytes: await walWritten(),
    pools,
  };
}

export async function handleUsageRollupOperation(request: Request, db: HistoryDatabase) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method === "GET") {
    const planned = await planUsageRollup(db);
    // The apply measures its write-ahead log; a role that cannot read it fails here, before writes.
    await db.query("SELECT pg_current_wal_lsn()");
    return Response.json(
      { status: "dry-run", version: historyUsageRollupBackfillVersion, ...planned, writes: false },
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
  // A person may approve a longer hour, never past what writers wait for.
  const hourLimit = approval.hourLimitMs ?? usageRollupHourLimitMs;
  if (
    typeof hourLimit !== "number" ||
    !Number.isSafeInteger(hourLimit) ||
    hourLimit < usageRollupHourLimitMs ||
    hourLimit > usageRollupHourLimitMaxMs
  )
    return new Response(null, { status: 400 });
  const result = await runUsageRollup(db, plan, 12_000, undefined, walBudget, hourLimit);
  return Response.json(
    { ...result, version: historyUsageRollupBackfillVersion, digest: approval.digest },
    { headers },
  );
}
