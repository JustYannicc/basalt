import { createHash } from "node:crypto";
import { DATABASE_SCOPE, readBackupName, SafetyGateError, stableStringify, verifyBackupMetadata, type RecordedBackup } from "./contracts.ts";
import { releaseBackup, type BackupDeployment } from "./github-ledger.ts";
import { record, stringField } from "./http.ts";
import type { BackupRecord, BranchRecord } from "./planetscale-api.ts";

export type BackupInventory = {
  organization: string;
  database: string;
  branches: Array<{ branch: BranchRecord; backups: BackupRecord[] }>;
};

type BranchReview = {
  branch: string;
  latestMigrationRecoveryBackupId: string;
  pinnedBackupIds: string[];
  restoreDependentBackupIds: string[];
};

const day = 86_400_000;
export const backupSnapshotDigest = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");

export function backupRetirementReport(inventory: BackupInventory, history: BackupDeployment[], now: number, keepReview?: unknown) {
  if (!Number.isFinite(now)) throw new SafetyGateError("Backup report time is invalid");
  const inventoryDigest = backupSnapshotDigest(inventory);
  const ledgerDigest = backupSnapshotDigest(history);
  const holds: string[] = [];
  let reviews: BranchReview[] = [];
  try {
    reviews = parseKeepReview(keepReview, inventory, inventoryDigest, ledgerDigest, now);
  } catch (error) {
    if (!(error instanceof SafetyGateError)) throw error;
    holds.push(error.message);
  }
  if (history.length === 0 || history.some(entry => !entry.payload)) holds.push("release-ledger-unverified");
  const references = new Map<string, RecordedBackup>();
  const keep = new Map<string, Set<string>>();
  const key = (branch: string, name: string) => JSON.stringify([branch, name]);
  const retain = (backup: RecordedBackup, reason: string, mustExist = false) => {
    const id = key(backup.metadata.scope.branch, backup.name);
    const previous = references.get(id);
    if (previous && stableStringify(previous.metadata) !== stableStringify(backup.metadata)) holds.push("release-backup-metadata-conflicts");
    references.set(id, { name: backup.name, metadata: backup.metadata });
    if (reason) keep.set(id, new Set([...(keep.get(id) ?? []), reason]));
    if (mustExist && !inventory.branches.some(({ branch, backups }) => branch.name === backup.metadata.scope.branch && backups.some(item => item.name === backup.name)))
      holds.push("required-recovery-backup-missing-from-production-inventory");
  };
  const selectedBackup = (entry: BackupDeployment) => entry.payload && releaseBackup({
    state: "ready", deploymentId: entry.id, gitCommit: entry.gitCommit, pins: entry.payload.pins, payload: entry.payload,
  });
  for (const entry of history) {
    const payload = entry.payload;
    if (!payload) continue;
    const reason = entry.successful ? "" : "unresolved-release";
    if (payload.backupName && payload.backupMetadata) retain({ name: payload.backupName, metadata: payload.backupMetadata }, reason, !!reason);
    if (payload.rollbackBackup) retain(payload.rollbackBackup, reason, !!reason);
  }
  const latest = history[0];
  if (latest?.payload && (latest.payload.backupName || latest.payload.rollbackBackup)) {
    const selected = selectedBackup(latest);
    if (selected) retain(selected, "current-exact-rollback-backup", true);
  }
  const migration = history.find(entry => entry.successful && entry.payload?.databaseChanged);
  if (migration?.payload) {
    const selected = selectedBackup(migration);
    if (selected) retain(selected, "latest-release-migration-recovery", true);
  }
  const rows = inventory.branches.flatMap(({ branch, backups }) => {
    const branchHolds: string[] = [];
    if (!branch.production || branch.kind !== "postgresql" || !branch.ready || branch.state !== "ready") branchHolds.push("production-branch-unverified");
    const completed = backups.filter(backup => backup.name.startsWith("basalt-release-") && backup.state === "success" && backup.deleted_at === null);
    if (completed.some(backup => !validTime(backup.created_at, now))) branchHolds.push("completed-release-order-unverified");
    completed.sort((left, right) => Date.parse(String(right.created_at)) - Date.parse(String(left.created_at)) || left.id.localeCompare(right.id));
    const ranks = new Map(completed.map((backup, index) => [backup.id, index + 1]));
    const review = reviews.find(item => item.branch === branch.name);
    return backups.map(backup => {
      const reasons = [...holds, ...branchHolds, ...(keep.get(key(branch.name, backup.name)) ?? [])];
      const ageDays = validTime(backup.created_at, now) ? (now - Date.parse(backup.created_at)) / day : null;
      const rank = ranks.get(backup.id) ?? null;
      const sizeBytes = typeof backup.size === "number" && Number.isSafeInteger(backup.size) && backup.size >= 0 ? backup.size : null;
      const metadata = references.get(key(branch.name, backup.name));
      try {
        if (!readBackupName(backup.name)) reasons.push("outside-release-policy");
        else if (!metadata || verifyBackupMetadata(backup.name, metadata.metadata).scope.branch !== branch.name) reasons.push("release-ownership-unverified");
      } catch (error) {
        if (!(error instanceof SafetyGateError)) throw error;
        reasons.push("release-ownership-unverified");
      }
      if (backups.filter(item => item.name === backup.name).length !== 1) reasons.push("ambiguous-backup-name");
      if (backup.state !== "success" || backup.deleted_at !== null || !backup.protected) reasons.push("completed-protected-backup-unverified");
      if (backup.required !== false || backup.backup_policy !== null) reasons.push("provider-policy-or-unverified");
      if (!isObject(backup.database_branch) || backup.database_branch.name !== branch.name) reasons.push("backup-branch-unverified");
      if (!Array.isArray(backup.restored_branches)) reasons.push("restore-dependencies-unverified");
      else if (backup.restored_branches.length) reasons.push("restore-dependent-backup");
      if (sizeBytes === null) reasons.push("backup-size-unverified");
      if (ageDays === null || ageDays <= 30) reasons.push("not-older-than-30-days");
      if (rank === null || rank <= 10) reasons.push("newest-ten-or-order-unverified");
      if (review?.latestMigrationRecoveryBackupId === backup.id) reasons.push("latest-production-migration-recovery");
      if (review?.pinnedBackupIds.includes(backup.id)) reasons.push("explicit-pin");
      if (review?.restoreDependentBackupIds.includes(backup.id)) reasons.push("reviewed-restore-dependency");
      return {
        branch: branch.name, id: backup.id, name: backup.name, protected: backup.protected,
        ageDays, completedReleaseRank: rank, sizeBytes,
        decision: reasons.length ? "keep" as const : "candidate" as const,
        reasons: [...new Set(reasons)].sort(),
      };
    });
  });
  const candidates = rows.filter(row => row.decision === "candidate").map(({ branch, id, name }) => ({ branch, id, name }));
  return {
    schemaVersion: 1, readOnly: true, deletionAuthorized: false,
    observedAt: new Date(now).toISOString(),
    scope: { organization: inventory.organization, database: inventory.database },
    policy: { olderThanDays: 30, keepNewestCompletedReleaseBackups: 10 },
    inventoryDigest, ledgerDigest, holds: [...new Set(holds)].sort(), candidates, backups: rows,
  };
}

function parseKeepReview(value: unknown, inventory: BackupInventory, inventoryDigest: string, ledgerDigest: string, now: number): BranchReview[] {
  const review = record(value, "keep-review-required");
  const scope = record(review.scope, "keep-review-scope-invalid");
  if (review.schemaVersion !== 1 || scope.organization !== inventory.organization || scope.database !== DATABASE_SCOPE.database || inventory.database !== DATABASE_SCOPE.database)
    throw new SafetyGateError("keep-review-scope-mismatch");
  if (review.inventoryDigest !== inventoryDigest || review.ledgerDigest !== ledgerDigest) throw new SafetyGateError("keep-review-snapshot-mismatch");
  if (!validTime(review.reviewedAt, now)) throw new SafetyGateError("keep-review-time-invalid");
  if (!Array.isArray(review.branches) || review.branches.length !== inventory.branches.length) throw new SafetyGateError("keep-review-branch-coverage-incomplete");
  const seen = new Set<string>();
  return review.branches.map(value => {
    const item = record(value, "keep-review-branch-invalid");
    const branch = stringField(item.branch, "keep-review-branch-name");
    const snapshot = inventory.branches.find(entry => entry.branch.name === branch);
    if (!snapshot || seen.has(branch)) throw new SafetyGateError("keep-review-branch-coverage-incomplete");
    seen.add(branch);
    const latestMigrationRecoveryBackupId = stringField(item.latestMigrationRecoveryBackupId, "latest-migration-recovery-backup-required");
    const pinnedBackupIds = ids(item.pinnedBackupIds);
    const restoreDependentBackupIds = ids(item.restoreDependentBackupIds);
    if ([latestMigrationRecoveryBackupId, ...pinnedBackupIds, ...restoreDependentBackupIds].some(id => !snapshot.backups.some(backup => backup.id === id)))
      throw new SafetyGateError("keep-review-backup-id-outside-snapshot");
    return { branch, latestMigrationRecoveryBackupId, pinnedBackupIds, restoreDependentBackupIds };
  });
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id.trim()) || new Set(value).size !== value.length)
    throw new SafetyGateError("keep-review-backup-ids-invalid");
  return value;
}

function validTime(value: unknown, now: number): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
