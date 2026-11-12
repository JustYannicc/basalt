import type { PoolReliabilitySlo } from "../../../apps/pool/reliability-contract.ts";
import { digest } from "../backend-users.ts";
import type { HistoryDatabase } from "./schema.ts";
import { readPoolReliability } from "./reliability.ts";

export function reliabilityState(
  hour: PoolReliabilitySlo["hour"],
  day: PoolReliabilitySlo["day"],
): "ok" | "breached" | "no_traffic" {
  const windows = [hour, day];
  // Compare integer counts: rounding 98.999... to 99 must never suppress an alarm.
  if (windows.some(({ real }) => BigInt(real.failed) * 100n > BigInt(real.requests)))
    return "breached";
  return windows.every(({ real }) => real.requests === 0) ? "no_traffic" : "ok";
}

/** Capture runs every five minutes. An old or unfinished capture cannot prove an SLO. */
export async function readPoolReliabilitySlo(
  db: HistoryDatabase,
  pool: string,
  now = Date.now(),
  transaction: "owned" | "caller" = "owned",
): Promise<PoolReliabilitySlo> {
  const to = new Date(now).toISOString();
  if (transaction === "owned")
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    const hour = await readPoolReliability(db, pool, new Date(now - 3_600_000).toISOString(), to);
    const day = await readPoolReliability(db, pool, new Date(now - 86_400_000).toISOString(), to);
    const row = (
      await db.query(
        `SELECT backfill_complete,forward_id::text,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at
      FROM basalt_model_history_cursor WHERE source=$1`,
        [await digest("home-local-v1")],
      )
    ).rows[0];
    const captureAt = typeof row?.captured_at === "string" ? row.captured_at : null;
    const captured = captureAt === null ? NaN : Date.parse(captureAt);
    const sourceExists =
      (await db.query("SELECT to_regclass('usage') IS NOT NULL AS ready")).rows[0]?.ready === true;
    // A recent collector commit can still leave more than its bounded batch uncaptured.
    const lagging =
      row &&
      sourceExists &&
      (
        await db.query("SELECT EXISTS (SELECT 1 FROM usage WHERE id > $1::bigint) AS lagging", [
          row.forward_id,
        ])
      ).rows[0]?.lagging === true;
    const reason =
      !row || !sourceExists || row.backfill_complete !== true
        ? "history_inactive"
        : !Number.isFinite(captured) || captured > now + 30_000 || now - captured > 10 * 60_000
          ? "capture_stale"
          : lagging
            ? "capture_lagging"
            : hour.classification !== "ready" || day.classification !== "ready"
              ? "classification_pending"
              : undefined;
    if (transaction === "owned") await db.query("COMMIT");
    return {
      target: 99,
      state: reason ? "unavailable" : reliabilityState(hour, day),
      captureAt,
      ...(reason ? { reason } : {}),
      hour,
      day,
    };
  } catch (error) {
    if (transaction === "owned") await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
