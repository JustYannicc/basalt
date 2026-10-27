import type { AttemptWindow } from "./github-ledger.ts";
import type { ClassificationReport } from "../releases/types.ts";
import {
  backupMatchesReport,
  createRecordedBackup,
  DATABASE_SCOPE,
  readBackupName,
  SafetyGateError,
  verifyBackupMetadata,
  type BackupMetadata,
  type RecordedBackup,
} from "./contracts.ts";
import { record, type Fetcher } from "./http.ts";
import { PlanetScaleApi, type BackupRecord, type BranchRecord, type DatabaseRecord, type PlanetScaleCredentials } from "./planetscale-api.ts";

export type BackupGateResult =
  | { state: "skipped"; reason: "not-database-changing" | "initial-database-absent" }
  | { state: "ready"; backupName: string; backupId: string };

export type ReadyBackup = { backup: BackupRecord; metadata: BackupMetadata };

export type ManualRollbackTarget = {
  backupId: string;
  backupName: string;
  productionBranch: string;
  base: BackupMetadata["base"];
  candidate: BackupMetadata["candidate"];
  logicalDatabases: readonly string[];
  manualRestoreRequired: true;
};

export type WaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const defaultWait: Required<WaitOptions> = {
  timeoutMs: 30 * 60 * 1000,
  pollIntervalMs: 5_000,
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export class PlanetScaleSafety {
  private readonly api: PlanetScaleApi;
  private readonly waitOptions: WaitOptions;

  constructor(
    credentials: PlanetScaleCredentials,
    fetcher: Fetcher = fetch,
    waitOptions: WaitOptions = {},
  ) {
    this.api = new PlanetScaleApi(credentials, fetcher);
    this.waitOptions = waitOptions;
  }

  /**
   * Every initial attempt checks absence before it deploys and records its start before it can create
   * the database. A database created inside a failed attempt's window, between its start and its final
   * status, was created by that attempt, so a retry may continue with it. Any other existing database,
   * or one without a creation time, still stops the release.
   */
  async assertInitialDatabaseAbsent(attempts: readonly AttemptWindow[] = []): Promise<void> {
    const matches = await this.api.listDatabases(DATABASE_SCOPE.database);
    const existing = matches.find((database) => database.name === DATABASE_SCOPE.database);
    if (!existing) return;
    const createdAt = typeof existing.created_at === "string" ? Date.parse(existing.created_at) : Number.NaN;
    const ownAttempt = Number.isFinite(createdAt) && attempts.some(({ startedAt, endedAt }) =>
      Date.parse(startedAt) <= createdAt && createdAt <= Date.parse(endedAt));
    if (!ownAttempt)
      throw new SafetyGateError("No successful deploy ledger exists, but the PlanetScale database already exists");
  }

  async ensureBackup(report: ClassificationReport, ledgerUninitialized: boolean): Promise<BackupGateResult> {
    if (!report.databaseChanged) return { state: "skipped", reason: "not-database-changing" };

    const databases = (await this.api.listDatabases(DATABASE_SCOPE.database))
      .filter((database) => database.name === DATABASE_SCOPE.database);
    if (databases.length === 0) {
      if (ledgerUninitialized) return { state: "skipped", reason: "initial-database-absent" };
      throw new SafetyGateError("PlanetScale production database is missing despite a successful deploy ledger");
    }
    if (ledgerUninitialized)
      throw new SafetyGateError("PlanetScale database exists without a successful deploy ledger; the initial-deploy exception does not apply");
    if (databases.length !== 1) throw new SafetyGateError("PlanetScale database lookup was ambiguous");

    const database = await this.api.getDatabase(DATABASE_SCOPE.database);
    assertProductionDatabase(database);
    const branch = await this.api.getBranch(DATABASE_SCOPE.database, database.default_branch);
    assertProductionBranch(branch);

    const expected = expectedBackup(report, branch);
    const existing = (await this.api.listBackups(DATABASE_SCOPE.database, branch.name))
      .filter((backup) => backup.name === expected.name);
    if (existing.length > 1) throw new SafetyGateError("Multiple PlanetScale backups claim the same release transition");

    const backup = existing[0] ?? await this.api.createBackup(DATABASE_SCOPE.database, branch.name, expected.name);
    const complete = await this.waitForBackup(expected, backup);
    return { state: "ready", backupName: expected.name, backupId: complete.id };
  }

  /**
   * With `recorded` (the ledger's backup name and metadata), only that exact verified backup counts.
   * Without it, each branch's expected name is recomputed from the report and that branch's current
   * context, so a branch resized since the backup no longer matches and the gate fails closed.
   */
  async assertBackupReady(report: ClassificationReport, recorded?: RecordedBackup): Promise<ReadyBackup> {
    if (!report.databaseChanged) throw new SafetyGateError("No database backup is required for this release");
    const matches = await this.findMatchingBackups(report, recorded);
    if (matches.length !== 1) throw new SafetyGateError("Expected exactly one recorded rollback backup for this release transition");
    const { backup, metadata } = matches[0]!;
    assertBackupRecord(backup, metadata);
    const detail = await this.api.getBackup(DATABASE_SCOPE.database, metadata.scope.branch, backup.id);
    if (detail.name !== backup.name) throw new SafetyGateError("PlanetScale returned a backup with an unexpected name");
    assertBackupRecord(detail, metadata);
    return { backup: detail, metadata };
  }

  async manualRollbackTarget(report: ClassificationReport, recorded?: RecordedBackup): Promise<ManualRollbackTarget> {
    const { backup, metadata } = await this.assertBackupReady(report, recorded);
    return {
      backupId: backup.id,
      backupName: backup.name,
      productionBranch: metadata.scope.branch,
      base: metadata.base,
      candidate: metadata.candidate,
      logicalDatabases: metadata.scope.logicalDatabases,
      manualRestoreRequired: true,
    };
  }

  /** `expected` was just derived from the report and branch, so only the provider's record needs checking. */
  private async waitForBackup(expected: RecordedBackup, initial: BackupRecord): Promise<BackupRecord> {
    const branchName = expected.metadata.scope.branch;
    let backup = initial;
    const wait = { ...defaultWait, ...this.waitOptions };
    const deadline = wait.now() + wait.timeoutMs;
    while (true) {
      if (backup.name !== expected.name) throw new SafetyGateError("PlanetScale returned a backup with an unexpected name");
      if (backup.state === "success") {
        let current = backup;
        if (!current.protected) current = await this.api.protectBackup(DATABASE_SCOPE.database, branchName, current.id);
        if (current.state !== "success" || !current.protected)
          throw new SafetyGateError("PlanetScale backup completed but could not be protected");
        current = await this.api.getBackup(DATABASE_SCOPE.database, branchName, current.id);
        if (current.name !== expected.name) throw new SafetyGateError("PlanetScale returned a backup with an unexpected name");
        assertBackupRecord(current, expected.metadata);
        return current;
      }
      if (backup.state !== "pending" && backup.state !== "running")
        throw new SafetyGateError(`PlanetScale backup ended in state ${backup.state}`);
      if (wait.now() >= deadline) throw new SafetyGateError("PlanetScale backup did not complete before the safety timeout");
      await wait.sleep(wait.pollIntervalMs);
      backup = await this.api.getBackup(DATABASE_SCOPE.database, branchName, backup.id);
    }
  }

  private async findMatchingBackups(report: ClassificationReport, recorded?: RecordedBackup): Promise<ReadyBackup[]> {
    if (recorded) assertBackupMatchesReport(verifyBackupMetadata(recorded.name, recorded.metadata), report);
    const databaseMatches = await this.api.listDatabases(DATABASE_SCOPE.database);
    if (!databaseMatches.some((database) => database.name === DATABASE_SCOPE.database && database.kind === "postgresql"))
      throw new SafetyGateError("PlanetScale production database is not available for rollback");

    const matches: ReadyBackup[] = [];
    const branches = await this.api.listBranches(DATABASE_SCOPE.database);
    for (const branch of branches) {
      if (branch.kind !== "postgresql") continue;
      const expected = recorded ?? expectedBackup(report, branch);
      for (const backup of await this.api.listBackups(DATABASE_SCOPE.database, branch.name)) {
        // Foreign backups are skipped; a malformed Basalt name throws here.
        const format = readBackupName(backup.name);
        if (format?.format === "v1") {
          if ((!recorded || backup.name === recorded.name) && backupMatchesReport(format.metadata, report))
            matches.push({ backup, metadata: format.metadata });
        } else if (format && backup.name === expected.name) {
          matches.push({ backup, metadata: expected.metadata });
        }
      }
    }
    return matches;
  }
}

function expectedBackup(report: ClassificationReport, branch: BranchRecord): RecordedBackup {
  return createRecordedBackup(report, branch.name, branch.cluster_name, branch.has_replicas);
}

function assertProductionDatabase(database: DatabaseRecord): void {
  if (database.name !== DATABASE_SCOPE.database || database.kind !== "postgresql" || !database.ready)
    throw new SafetyGateError("PlanetScale database is not the ready PostgreSQL production database");
}

function assertProductionBranch(branch: BranchRecord): void {
  if (branch.kind !== "postgresql" || !branch.ready || branch.state !== "ready" || !branch.production)
    throw new SafetyGateError("PlanetScale default branch is not a ready PostgreSQL production branch");
}

function assertBackupMatchesReport(metadata: BackupMetadata, report: ClassificationReport): void {
  if (!backupMatchesReport(metadata, report))
    throw new SafetyGateError("PlanetScale backup metadata does not match the classified release transition");
}

function assertBackupRecord(backup: BackupRecord, metadata: BackupMetadata): void {
  if (backup.state !== "success" || !backup.protected)
    throw new SafetyGateError("Rollback backup is not both complete and protected");
  if (backup.deleted_at !== null && backup.deleted_at !== undefined)
    throw new SafetyGateError("Rollback backup has been deleted");
  const branch = record(backup.database_branch, "PlanetScale backup database branch");
  if (branch.name !== metadata.scope.branch)
    throw new SafetyGateError("Rollback backup belongs to a different PlanetScale branch");
}
