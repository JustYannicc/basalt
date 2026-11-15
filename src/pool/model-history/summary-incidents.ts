import type { PoolUsageSummaryResult } from "../../../apps/pool/usage-overview-contract.ts";
import type { HistoryDatabase } from "./schema.ts";
import { readPoolReliabilityWindows } from "./reliability.ts";

export async function summaryIncidents(
  db: HistoryDatabase,
  pool: string,
  to: string,
  captureComplete: boolean,
  terminalReady: boolean,
): Promise<Pick<PoolUsageSummaryResult, "incidents" | "reliability">> {
  const from = new Date(Date.parse(to) - 3_600_000).toISOString();
  const unavailable = {
    incidents: { from, to, status: "unavailable" as const, requests: 0, failed: 0, failures: [] },
  };
  await db.query("SAVEPOINT summary_incidents");
  try {
    const [value, day] = await readPoolReliabilityWindows(
      db,
      pool,
      [
        { from, to },
        { from: new Date(Date.parse(to) - 86_400_000).toISOString(), to },
      ],
      terminalReady,
    );
    if (!value || !day) throw new Error("Missing reliability window");
    const canceled = value.real.failures.find((failure) => failure.status === 499)?.count ?? 0;
    await db.query("RELEASE SAVEPOINT summary_incidents");
    if (value.classification !== "ready") return unavailable;
    return {
      reliability: { hour: value, day },
      incidents: {
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
      },
    };
  } catch {
    await db.query("ROLLBACK TO SAVEPOINT summary_incidents");
    await db.query("RELEASE SAVEPOINT summary_incidents");
    return unavailable;
  }
}
