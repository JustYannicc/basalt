import type {
  PoolReliability,
  PoolReliabilitySlo,
} from "../../../apps/pool/reliability-contract.ts";
import { digest } from "../backend-users.ts";
import { reportingReliabilityStatements } from "./reliability-read-failure.ts";
import type { HistoryDatabase } from "./schema.ts";
import { readPoolReliabilityWindows, terminalCollectionReady } from "./reliability.ts";
import { HistoryInputError } from "./record.ts";
import { objectiveVerdict, readUnknownOutcomes } from "./reliability-unknown.ts";

export function reliabilityState(
  hour: PoolReliabilitySlo["hour"],
  day: PoolReliabilitySlo["day"],
): PoolReliabilitySlo["state"] {
  return objectiveVerdict(hour, day).state;
}

/** Capture runs every five minutes. An old or unfinished capture cannot prove an SLO. */
export async function readPoolReliabilitySlo(
  history: HistoryDatabase,
  pool: string,
  now = Date.now(),
  transaction: "owned" | "caller" = "owned",
): Promise<PoolReliabilitySlo> {
  const db = reportingReliabilityStatements(
    history,
    transaction === "owned" ? "standalone" : "overview",
  );
  const to = new Date(now).toISOString();
  if (transaction === "owned")
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    const terminalReady = await terminalCollectionReady(db);
    const [hour, day, current] = await readPoolReliabilityWindows(
      db,
      pool,
      [3_600_000, 86_400_000, 300_000].map((duration) => ({
        from: new Date(now - duration).toISOString(),
        to,
      })),
      terminalReady,
    );
    if (hour === undefined || day === undefined || current === undefined)
      throw new HistoryInputError();
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
    // Ready classification means the traffic table exists, so proof traffic can be told apart.
    const unknown = terminalReady
      ? await readUnknownOutcomes(db, pool, [hour, day, current], hour.classification === "ready")
      : [];
    const withUnknown = (window: PoolReliability, index: number): PoolReliability => {
      const outcomes = unknown[index];
      return outcomes ? { ...window, unknown: outcomes } : window;
    };
    const hourWindow = withUnknown(hour, 0),
      dayWindow = withUnknown(day, 1),
      currentWindow = withUnknown(current, 2);
    const reason = !terminalReady
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
    // These blockers come first: without complete collection no count can settle the objective.
    const verdict = reason ? undefined : objectiveVerdict(hourWindow, dayWindow);
    if (transaction === "owned") await db.query("COMMIT");
    return {
      target: 99,
      state: verdict?.state ?? "unavailable",
      captureAt,
      ...(reason ? { reason } : verdict?.reason ? { reason: verdict.reason } : {}),
      current: currentWindow,
      hour: hourWindow,
      day: dayWindow,
    };
  } catch (error) {
    if (transaction === "owned") await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
