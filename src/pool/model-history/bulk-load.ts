import type { BulkGuard } from "./bulk-contract.ts";

export const targetChunkMs = 500;
export const minimumChunkRows = 100;
export const initialChunkRows = 500;
export const criticalCpuMs = 120_000;
export interface BulkLoad {
  cpuThrottled: boolean;
  criticalSince: number | null;
  lastCpuAt: number | null;
}
export const initialLoad = (): BulkLoad => ({
  cpuThrottled: false,
  criticalSince: null,
  lastCpuAt: null,
});
export function freshObservation(guard: BulkGuard | null, now: number): guard is BulkGuard {
  return (
    guard !== null &&
    [
      guard.observedAt,
      guard.expiresAt,
      guard.cpuAt,
      guard.cpu,
      guard.poolErrors,
      guard.queryErrors,
    ].every(Number.isFinite) &&
    guard.cpu >= 0 &&
    guard.cpu <= 100 &&
    Number.isSafeInteger(guard.poolErrors) &&
    guard.poolErrors >= 0 &&
    Number.isSafeInteger(guard.queryErrors) &&
    guard.queryErrors >= 0 &&
    typeof guard.ready === "boolean" &&
    typeof guard.releaseReadComplete === "boolean" &&
    typeof guard.releaseWindowActive === "boolean" &&
    guard.cpuAt <= guard.observedAt &&
    now - guard.cpuAt <= 180_000 &&
    guard.observedAt <= now &&
    guard.expiresAt > now &&
    guard.expiresAt - guard.observedAt <= 90_000 &&
    now - guard.observedAt <= 90_000
  );
}
export function observeLoad(load: BulkLoad, guard: BulkGuard | null, now: number) {
  if (!freshObservation(guard, now)) return "guard_paused";
  if (load.lastCpuAt !== null && guard.cpuAt < load.lastCpuAt) return "guard_paused";
  if (guard.cpu >= 90 && load.criticalSince === null) load.criticalSince = guard.cpuAt;
  if (guard.cpuAt !== load.lastCpuAt) {
    if (guard.cpu >= 90) {
      if (
        load.criticalSince === null ||
        load.lastCpuAt === null ||
        guard.cpuAt - load.lastCpuAt > 90_000
      )
        load.criticalSince = guard.cpuAt;
    } else load.criticalSince = null;
    load.lastCpuAt = guard.cpuAt;
  }
  if (guard.queryErrors > 0) return "database_error";
  if (
    guard.cpu >= 90 &&
    load.criticalSince !== null &&
    guard.cpuAt - load.criticalSince >= criticalCpuMs
  )
    return "critical_cpu";
  if (guard.cpu >= 70) load.cpuThrottled = true;
  else if (guard.cpu < 60) load.cpuThrottled = false;
  if (!guard.releaseReadComplete) return "guard_paused";
  if (guard.releaseWindowActive) return "release_backup";
  if (load.cpuThrottled) return "cpu_high";
  if (guard.poolErrors > 0) return "pool_errors";
  return guard.ready ? null : "guard_paused";
}
export const criticalLoad = (reason: string | null) =>
  reason === "database_error" || reason === "critical_cpu";
export const automaticThrottle = (reason: string | null) =>
  reason !== null &&
  [
    "guard_paused",
    "cpu_high",
    "release_backup",
    "pool_errors",
    "serving_unavailable",
    "serving_stale",
    "serving_regressed",
  ].includes(reason);

/** Limit growth to one doubling so one unusually cheap transaction cannot create a large burst. */
export function resizeChunk(rows: number, elapsedMs: number) {
  return Math.max(
    minimumChunkRows,
    Math.min(5000, rows * 2, Math.round((rows * targetChunkMs) / Math.max(1, elapsedMs))),
  );
}
