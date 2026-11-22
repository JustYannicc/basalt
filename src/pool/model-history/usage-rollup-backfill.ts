import { digest } from "../backend-users.ts";
import { historyObject, invalidHistory } from "./record.ts";
import type { HistoryDatabase } from "./schema.ts";
import { historyUsageRollupVersion } from "./usage-rollup-schema.ts";

export const historyUsageRollupPath = "/model-history/usage-rollup";
export const historyUsageRollupBackfillVersion = "usage_rollup_backfill_v1";

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
        const from = midnight(new Date(row.first_at as string | Date).getTime());
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
 * Recomputes the plan's days, one UTC day per transaction, until the time budget runs out. A day
 * already recomputed in full is skipped, so a stopped or failed run resumes where it left off; a
 * pool is marked ready only after its last day. Returns counts only.
 */
export async function runUsageRollup(
  db: HistoryDatabase,
  plan: UsageRollupPlan,
  budgetMs = 20_000,
  now: () => number = () => performance.now(),
) {
  const started = now();
  const pools: { pool: string; recomputedDays: number; groups: number; remainingDays: number }[] =
    [];
  let complete = true;
  for (const item of plan.pools) {
    const done = await db.query(
      `SELECT d.at FROM generate_series($2::timestamptz,$3::timestamptz-interval '1 day',interval '1 day') AS d(at)
      WHERE (SELECT count(*) FROM basalt_model_usage_hours h
        WHERE h.pool=$1 AND h.hour >= d.at AND h.hour < d.at + interval '1 day') < 24
      ORDER BY d.at`,
      [item.pool, item.from, item.to],
    );
    const pending = done.rows.map((row) => new Date(String(row.at)).toISOString());
    let recomputedDays = 0,
      groups = 0;
    for (const at of pending) {
      if (now() - started >= budgetMs) break;
      await db.query("BEGIN");
      try {
        await db.query("SET LOCAL statement_timeout = '6s'");
        await db.query("SET LOCAL lock_timeout = '2s'");
        const written = await db.query(
          "SELECT basalt_model_usage_recompute($1,$2::timestamptz,$2::timestamptz + interval '1 day') AS groups",
          [item.pool, at],
        );
        await db.query("COMMIT");
        groups += Number(written.rows[0]?.groups ?? 0);
        recomputedDays++;
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
    const remainingDays = pending.length - recomputedDays;
    if (remainingDays === 0)
      await db.query(
        `INSERT INTO basalt_model_usage_ready (pool,through) VALUES ($1,$2::timestamptz)
        ON CONFLICT (pool) DO NOTHING`,
        [item.pool, item.to],
      );
    else complete = false;
    pools.push({ pool: item.pool, recomputedDays, groups, remainingDays });
    if (!complete) break;
  }
  return { status: complete ? ("complete" as const) : ("progress" as const), pools };
}

export async function handleUsageRollupOperation(request: Request, db: HistoryDatabase) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method === "GET") {
    const planned = await planUsageRollup(db);
    return Response.json(
      { status: "dry-run", version: historyUsageRollupBackfillVersion, ...planned, writes: false },
      { headers },
    );
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const approval = historyObject(await request.json());
  if (approval.go !== true) return new Response(null, { status: 400 });
  const plan = approvedUsageRollupPlan(approval.plan);
  if (approval.digest !== (await digest(JSON.stringify(plan))))
    return new Response(null, { status: 409 });
  const result = await runUsageRollup(db, plan, 12_000);
  return Response.json(
    { ...result, version: historyUsageRollupBackfillVersion, digest: approval.digest },
    { headers },
  );
}
