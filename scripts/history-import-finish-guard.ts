/** One observation written by the operator's single production metrics reader. */
export interface FinishObservation {
  observedAt: string;
  cpu: number;
  queryErrors: number;
  sentryNew: number;
  releaseActive: boolean;
  /** Primary volume, from the platform's instant metrics; the import's WAL and heap land here. */
  diskPct: number;
  capacityBytes: number;
  usedBytes: number;
}
export interface FinishGuardState {
  throttled: boolean;
  criticalSince: number | null;
  lastAt: number | null;
}
export type FinishDecision =
  | { kind: "go" }
  | { kind: "wait"; reason: "guard_stale" | "guard_invalid" | "cpu_high" }
  | { kind: "pause"; reason: "query_errors" | "sentry_errors" | "release_active" }
  | { kind: "stop"; reason: "critical_cpu" | "disk_high" };

export const finishGuardLimits = {
  pauseCpu: 70,
  resumeCpu: 60,
  criticalCpu: 90,
  criticalMs: 120_000,
  staleMs: 90_000,
  // 2026-11-18: an 8 GB WAL budget on a 10 GiB volume made the primary read-only mid-import.
  maxDiskPct: 60,
} as const;

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
function valid(value: unknown): value is FinishObservation {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.observedAt === "string" &&
    typeof o.cpu === "number" &&
    Number.isFinite(o.cpu) &&
    o.cpu >= 0 &&
    o.cpu <= 100 &&
    count(o.queryErrors) &&
    count(o.sentryNew) &&
    typeof o.releaseActive === "boolean" &&
    typeof o.diskPct === "number" &&
    o.diskPct >= 0 &&
    o.diskPct <= 100 &&
    count(o.capacityBytes) &&
    (o.capacityBytes as number) > 0 &&
    count(o.usedBytes)
  );
}

/**
 * bulk-load.ts thresholds: pause at 70, resume below 60, 90 sustained for 120 s is a durable stop.
 * Anything the reader cannot vouch for holds the load; errors and releases pause it for a person.
 */
export function decide(state: FinishGuardState, observation: unknown, now: number): FinishDecision {
  if (!valid(observation))
    return { kind: "wait", reason: observation == null ? "guard_stale" : "guard_invalid" };
  const at = Date.parse(observation.observedAt);
  if (!Number.isFinite(at) || now - at > finishGuardLimits.staleMs || at > now + 5000)
    return { kind: "wait", reason: "guard_stale" };
  // A gap in readings is not evidence of sustained load, so it restarts the critical window.
  if (state.lastAt !== null && at - state.lastAt > finishGuardLimits.staleMs)
    state.criticalSince = null;
  state.lastAt = at;
  if (observation.diskPct > finishGuardLimits.maxDiskPct)
    return { kind: "stop", reason: "disk_high" };
  if (observation.queryErrors > 0) return { kind: "pause", reason: "query_errors" };
  if (observation.sentryNew > 0) return { kind: "pause", reason: "sentry_errors" };
  if (observation.releaseActive) return { kind: "pause", reason: "release_active" };
  if (observation.cpu >= finishGuardLimits.criticalCpu) {
    state.criticalSince ??= at;
    if (at - state.criticalSince >= finishGuardLimits.criticalMs)
      return { kind: "stop", reason: "critical_cpu" };
  } else state.criticalSince = null;
  if (observation.cpu >= finishGuardLimits.pauseCpu) state.throttled = true;
  else if (observation.cpu < finishGuardLimits.resumeCpu) state.throttled = false;
  return state.throttled ? { kind: "wait", reason: "cpu_high" } : { kind: "go" };
}

const transientCodes = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08006",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
]);
/** A dropped or stalled connection (resize cutover, failover) is retried once; everything else stops. */
export function isConnectionReset(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && transientCodes.has(code)) return true;
  return (
    typeof message === "string" &&
    /Connection terminated|connection.*closed|not queryable|Query read timeout|timeout expired/i.test(
      message,
    )
  );
}

/** Logs carry a SQLSTATE and a bounded message, never a DETAIL line that could quote a value. */
export function errorSummary(error: unknown) {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  return {
    code: typeof code === "string" ? code : null,
    message: String(message ?? error)
      .split("\n")[0]!
      .slice(0, 160),
  };
}

/**
 * Preflight: what the load can still add (the WAL budget plus the rows' heap and index growth) must
 * fit under half the volume, so autoscaling never has to race the import.
 */
export function diskHeadroom(
  o: Pick<FinishObservation, "capacityBytes" | "usedBytes">,
  walBudgetBytes: number,
  remainingRows: number,
  bytesPerRow: number,
) {
  const needed = o.usedBytes + walBudgetBytes + remainingRows * bytesPerRow;
  return { needed, limit: o.capacityBytes / 2, ok: needed <= o.capacityBytes / 2 };
}
