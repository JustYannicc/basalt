import type { ComputerStorage } from "./computer-registry.ts";

export const reportingCadence = 5 * 60_000;
type ReportingJob = "first-request" | "usage" | "account-observations" | "model-history";
type ReportingOutcome = "success" | "failure" | "partial" | "incomplete";
export interface ReportingProgress {
  rows: number | null;
  outcome?: ReportingOutcome;
}
interface ReportingEvent {
  job: ReportingJob;
  state: "ran";
  durationMs: number;
  rows: number | null;
  outcome: ReportingOutcome;
}

/** Claim before I/O so eviction and failed reads cannot restart five-second report polling. */
export async function reportWhenDue(
  storage: ComputerStorage,
  name: ReportingJob,
  work: (progress: ReportingProgress) => Promise<unknown>,
  now = Date.now(),
  telemetry: {
    report?: (event: ReportingEvent) => void;
    clock?: () => number;
  } = {},
): Promise<void> {
  const key = `pool-reporting-v1:${name}`;
  const due = await storage.get<number>(key);
  if (due !== undefined && due > now && due <= now + reportingCadence) return;
  await storage.put(key, now + reportingCadence);
  const clock = telemetry.clock ?? (() => performance.now());
  const start = clock();
  // Null means the remote job does not expose its row count, rather than zero work.
  const progress: ReportingProgress = { rows: null };
  try {
    await work(progress);
  } catch (error) {
    progress.outcome = "failure";
    throw error;
  } finally {
    try {
      const elapsed = clock() - start;
      (telemetry.report ?? ((event) => console.log("pool_background_job", event)))({
        job: name,
        state: "ran",
        durationMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
        rows: Number.isSafeInteger(progress.rows) && progress.rows! >= 0 ? progress.rows : null,
        outcome: progress.outcome ?? "success",
      });
    } catch {
      /* Telemetry must not change a reporting result. */
    }
  }
}
