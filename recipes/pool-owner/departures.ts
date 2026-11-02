import type { WorkflowStepContext } from "apps";
import { api, instant, record, ReadUnavailable, text } from "../common/api.ts";
import { requirements } from "../common/installation.ts";
import type { Observation } from "../common/types.ts";

const bounded = (value: string, limit: number) => {
  let result = "";
  for (const point of value) {
    if (result.length + point.length > limit) break;
    result += point;
  }
  return result;
};
const safeErrors = new Set([
  "lock-unavailable",
  "storage-error",
  "unlink-failed",
  "invalid-snapshot",
  "interrupted",
  "execution-failed",
]);

/** Observe cleanup only. Account authorization already stops use; this workflow never retries detachment. */
export async function readDepartures(
  context: WorkflowStepContext<typeof requirements>,
  app: string,
): Promise<Observation> {
  const at = Date.now();
  const unknown: Observation = {
    cursor: `departures:${at}`,
    at,
    verdict: "unknown",
    code: "departure-read-unavailable",
    failures: 0,
    successes: 0,
    since: at,
  };
  try {
    const page = record(
      await api(context, "GET", `apps/${encodeURIComponent(app)}/accounts/departures`),
    );
    const observedAt = instant(page?.observedAt);
    if (
      !page ||
      !Array.isArray(page.items) ||
      page.items.length > 100 ||
      typeof page.complete !== "boolean" ||
      observedAt === undefined ||
      observedAt > at + 10000 ||
      at - observedAt > 60000 ||
      typeof page.appName !== "string"
    )
      return unknown;
    const rows = page.items.map(record);
    if (
      rows.some(
        (row) =>
          !row ||
          !text(row.job) ||
          !text(row.account) ||
          !["queued", "running", "failed"].includes(String(row.status)) ||
          instant(row.updatedAt) === undefined ||
          (row.queuedAt !== null && instant(row.queuedAt) === undefined) ||
          (row.lastError !== null && !safeErrors.has(String(row.lastError))) ||
          typeof row.attempts !== "number" ||
          !Number.isInteger(row.attempts) ||
          row.attempts < 0,
      )
    )
      return unknown;
    const actionable = rows.filter(
      (row) =>
        row !== undefined &&
        (row.status === "failed" ||
          at - (instant(row.queuedAt) ?? instant(row.updatedAt)!) >= 5 * 60000),
    );
    const jobs = [...new Set(actionable.map((row) => String(row!.job)))].sort();
    return {
      ...unknown,
      at: observedAt,
      sourceAt: observedAt,
      readComplete: page.complete,
      verdict: actionable.length > 0 ? "action" : page.complete ? "healthy" : "unknown",
      code:
        actionable.length > 0
          ? "departure-cleanup-needs-attention"
          : page.complete
            ? "departure-cleanup-current"
            : "departure-inventory-incomplete",
      decision: JSON.stringify(jobs),
      details: actionable.slice(0, 8).map((row) => ({
        label: bounded(text(row!.accountLabel) || String(row!.account), 120),
        value: bounded(
          `Pool: ${page.appName}. Account: ${row!.account}. Job: ${row!.job}. ${row!.status}, attempt ${row!.attempts}. Last error: ${row!.lastError ?? "not recorded"}. ${row!.queuedAt === null ? "Enqueue time unknown; age is at least time since last update." : `Queued ${new Date(instant(row!.queuedAt)!).toISOString()}.`}`,
          500,
        ),
      })),
    };
  } catch (error) {
    return {
      ...unknown,
      verdict:
        error instanceof ReadUnavailable && [403, 404].includes(error.status)
          ? "withdraw"
          : "unknown",
    };
  }
}
