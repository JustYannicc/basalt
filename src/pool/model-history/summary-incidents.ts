import type { UsageSummaryIncidents } from "../../../apps/pool/usage-overview-contract.ts";
import type { HistoryDatabase } from "./schema.ts";
import { readPoolReliability } from "./reliability.ts";

export async function summaryIncidents(
  db: HistoryDatabase,
  pool: string,
  to: string,
  captureComplete: boolean,
): Promise<UsageSummaryIncidents> {
  const from = new Date(Date.parse(to) - 3_600_000).toISOString();
  await db.query("SAVEPOINT summary_incidents");
  try {
    const value = await readPoolReliability(db, pool, from, to);
    const canceled = value.real.failures.find((failure) => failure.status === 499)?.count ?? 0;
    await db.query("RELEASE SAVEPOINT summary_incidents");
    if (value.classification !== "ready")
      return { from, to, status: "unavailable", requests: 0, failed: 0, failures: [] };
    return {
      from,
      to,
      status: captureComplete ? "available" : "partial",
      requests: value.real.requests - canceled,
      failed: value.real.failed - canceled,
      failures: value.real.failures
        .filter((failure) => failure.status !== 499)
        .map((failure) => ({
          status: failure.status,
          count: failure.count,
        })),
    };
  } catch {
    await db.query("ROLLBACK TO SAVEPOINT summary_incidents");
    await db.query("RELEASE SAVEPOINT summary_incidents");
    return { from, to, status: "unavailable", requests: 0, failed: 0, failures: [] };
  }
}
