import type { PoolReliabilitySlo } from "../../../apps/pool/reliability-contract.ts";
import { digest } from "../backend-users.ts";
import { historyTerminalIntegrityVersion, type HistoryDatabase } from "./schema.ts";
import { readPoolReliability, terminalCollectionReady } from "./reliability.ts";

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
    const terminalReady = await terminalCollectionReady(db);
    const hour = await readPoolReliability(
      db,
      pool,
      new Date(now - 3_600_000).toISOString(),
      to,
      terminalReady,
    );
    const day = await readPoolReliability(
      db,
      pool,
      new Date(now - 86_400_000).toISOString(),
      to,
      terminalReady,
    );
    const current = await readPoolReliability(
      db,
      pool,
      new Date(now - 5 * 60_000).toISOString(),
      to,
      terminalReady,
    );
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
    const terminalPending = terminalReady
      ? (
          await db.query(
            `SELECT EXISTS (
            SELECT 1 FROM basalt_model_terminal_starts s
            LEFT JOIN basalt_model_terminal_finishes f USING (request_id)
            WHERE s.pool=$1 AND f.request_id IS NULL
              AND s.started_at >= $2::timestamptz - interval '24 hours'
              AND s.started_at <= $2::timestamptz - interval '10 minutes'
          ) AS pending`,
            [(await digest(pool)).slice(0, 16), to],
          )
        ).rows[0]?.pending === true
      : false;
    const homeSource = await digest("home-local-v1");
    const terminalUnavailable = terminalReady
      ? (
          await db.query(
            `SELECT
            EXISTS (
              SELECT 1 FROM basalt_model_terminal_starts s
              JOIN basalt_model_terminal_finishes f USING (request_id)
              WHERE s.pool=$1 AND f.outcome='unavailable'
                AND f.finished_at >= $2::timestamptz - interval '24 hours'
                AND f.finished_at < $2::timestamptz
            ) AS unavailable_finish,
            -- v7 is the correlation cutover; each newer Home row must have one finished receipt.
            EXISTS (
              SELECT 1 FROM basalt_model_requests h
              WHERE h.pool=$1 AND h.source=$3
                AND h.timestamp >= GREATEST($2::timestamptz - interval '24 hours', m.completed_at)
                AND h.timestamp < $2::timestamptz
                AND NOT EXISTS (
                  SELECT 1 FROM basalt_model_terminal_starts s
                  JOIN basalt_model_terminal_finishes f USING (request_id)
                  WHERE s.pool=h.pool AND s.request_id::text=h.request_id
                )
            ) AS unmatched_home
          FROM basalt_model_history_migrations m WHERE m.name=$4`,
            [(await digest(pool)).slice(0, 16), to, homeSource, historyTerminalIntegrityVersion],
          )
        ).rows[0]
      : undefined;
    const terminalHasGap =
      terminalUnavailable?.unavailable_finish === true ||
      terminalUnavailable?.unmatched_home === true;
    const reason = terminalPending
      ? "terminal_collection_pending"
      : !terminalReady || terminalHasGap
        ? "terminal_collection_unavailable"
        : !row || !sourceExists || row.backfill_complete !== true
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
      current,
      hour,
      day,
    };
  } catch (error) {
    if (transaction === "owned") await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
