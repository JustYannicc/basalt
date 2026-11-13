import { historyObject } from "../src/pool/model-history/record.ts";
import { servingObservation } from "../src/pool/model-history/bulk-serving-contract.ts";
import { parseServingState } from "../src/pool/model-history/bulk-serving.ts";
import type {
  BulkDefinition,
  BulkGuard,
  BulkStatus,
} from "../src/pool/model-history/bulk-contract.ts";
import { privateJson, fail } from "./bulk-cli-input.ts";
export function bulkStatus(raw: unknown, definition: BulkDefinition): BulkStatus {
  const value = historyObject(raw);
  if (
    value.job !== definition.job ||
    value.manifestDigest !== definition.manifestDigest ||
    value.accountMappingDigest !== definition.accountMappingDigest ||
    value.totalRows !== definition.manifest.totalRows ||
    value.totalChunks !== definition.manifest.chunks.length ||
    !["uploading", "running", "paused", "stopped", "completed"].includes(String(value.state)) ||
    !["uploadedChunks", "committedChunks", "inserted", "existing"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isSafeInteger(value[key]) &&
        Number(value[key]) >= 0,
    ) ||
    Number(value.uploadedChunks) > Number(value.totalChunks) ||
    Number(value.committedChunks) > Number(value.uploadedChunks) ||
    Number(value.inserted) + Number(value.existing) > Number(value.totalRows) ||
    !Number.isSafeInteger(value.chunkSize) ||
    Number(value.chunkSize) < 100 ||
    Number(value.chunkSize) > 5000 ||
    typeof value.rateRowsPerSecond !== "number" ||
    !Number.isFinite(value.rateRowsPerSecond) ||
    value.rateRowsPerSecond < 0 ||
    !Number.isSafeInteger(value.nextBatchAt) ||
    Number(value.nextBatchAt) < 0 ||
    typeof value.requiresAttention !== "boolean" ||
    value.requiresAttention !== (value.state === "stopped") ||
    (value.state === "completed" &&
      (value.committedChunks !== value.totalChunks ||
        Number(value.inserted) + Number(value.existing) !== value.totalRows))
  )
    fail("Server did not acknowledge the exact manifest and account map");
  const reasons = [
    "operator_paused",
    "guard_paused",
    "chunk_unavailable",
    "chunk_invalid",
    "admission_failed",
    "commit_failed",
    "cpu_high",
    "critical_cpu",
    "database_error",
    "release_backup",
    "pool_errors",
    "serving_unavailable",
    "serving_stale",
    "serving_regressed",
  ];
  if (value.reason !== null && !reasons.includes(String(value.reason)))
    fail("Unknown bulk pause reason");
  return {
    job: definition.job,
    state: String(value.state),
    manifestDigest: definition.manifestDigest,
    accountMappingDigest: definition.accountMappingDigest,
    totalRows: Number(value.totalRows),
    totalChunks: Number(value.totalChunks),
    uploadedChunks: Number(value.uploadedChunks),
    committedChunks: Number(value.committedChunks),
    inserted: Number(value.inserted),
    existing: Number(value.existing),
    reason: value.reason === null ? null : String(value.reason),
    chunkSize: Number(value.chunkSize),
    rateRowsPerSecond: Number(value.rateRowsPerSecond),
    nextBatchAt: Number(value.nextBatchAt),
    requiresAttention: value.requiresAttention === true,
    serving: parseServingState(value.serving),
  };
}
/** No timestamp or CPU reading is refreshed locally; missing fields revoke readiness. */
export async function readGuard(path: string): Promise<BulkGuard> {
  const stopped: BulkGuard = {
    observedAt: 0,
    expiresAt: 0,
    ready: false,
    cpu: 0,
    cpuAt: 0,
    releaseReadComplete: false,
    releaseWindowActive: false,
    poolErrors: 0,
    queryErrors: 0,
  };
  try {
    const value = historyObject(await privateJson(path, 16_384));
    for (const key of ["observedAt", "expiresAt", "cpuAt", "poolErrors", "queryErrors"])
      if (
        typeof value[key] !== "number" ||
        !Number.isSafeInteger(value[key]) ||
        Number(value[key]) < 0
      )
        return stopped;
    if (
      typeof value.ready !== "boolean" ||
      typeof value.releaseReadComplete !== "boolean" ||
      typeof value.releaseWindowActive !== "boolean" ||
      typeof value.cpu !== "number" ||
      !Number.isFinite(value.cpu) ||
      value.cpu < 0
    )
      return stopped;
    const guard: BulkGuard = {
      observedAt: Number(value.observedAt),
      expiresAt: Number(value.expiresAt),
      ready: value.ready,
      cpu: value.cpu,
      cpuAt: Number(value.cpuAt),
      releaseReadComplete: value.releaseReadComplete,
      releaseWindowActive: value.releaseWindowActive,
      serving: servingObservation(value.serving),
      poolErrors: Number(value.poolErrors),
      queryErrors: Number(value.queryErrors),
    };
    const now = Date.now();
    guard.ready =
      guard.ready &&
      guard.observedAt <= now &&
      guard.expiresAt > now &&
      guard.expiresAt - guard.observedAt <= 90_000 &&
      now - guard.observedAt <= 90_000 &&
      guard.cpu <= 100 &&
      guard.cpuAt <= guard.observedAt &&
      now - guard.cpuAt <= 180_000 &&
      guard.releaseReadComplete &&
      !guard.releaseWindowActive &&
      guard.poolErrors === 0 &&
      guard.queryErrors === 0;
    return guard;
  } catch {
    return stopped;
  }
}
