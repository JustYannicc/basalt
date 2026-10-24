import type { ClassificationReport } from "../releases/types.ts";
import {
  createBackupName,
  DATABASE_SCOPE,
  parseBackupName,
  SafetyGateError,
  stableStringify,
  summarizePins,
  type BackupMetadata,
} from "./contracts.ts";
import { record, type Fetcher } from "./http.ts";
import { PlanetScaleApi, type BackupRecord, type BranchRecord, type DatabaseRecord, type PlanetScaleCredentials } from "./planetscale-api.ts";

export type BackupGateResult =
  | { state: "skipped"; reason: "not-database-changing" | "initial-database-absent" }
  | { state: "ready"; backupName: string; backupId: string };

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

  async assertInitialDatabaseAbsent(): Promise<void> {
    const matches = await this.api.listDatabases(DATABASE_SCOPE.database);
    if (matches.some((database) => database.name === DATABASE_SCOPE.database))
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

    const backupName = createBackupName(report, branch.name, branch.cluster_name, branch.has_replicas);
    const existing = (await this.api.listBackups(DATABASE_SCOPE.database, branch.name))
      .filter((backup) => backup.name === backupName);
    if (existing.length > 1) throw new SafetyGateError("Multiple PlanetScale backups claim the same release transition");

    const backup = existing[0] ?? await this.api.createBackup(DATABASE_SCOPE.database, branch.name, backupName);
    const complete = await this.waitForBackup(report, backupName, branch.name, backup);
    return { state: "ready", backupName, backupId: complete.id };
  }

  async assertBackupReady(report: ClassificationReport, expectedBackupName?: string): Promise<BackupRecord> {
    if (!report.databaseChanged) throw new SafetyGateError("No database backup is required for this release");
    const matches = await this.findMatchingBackups(report, expectedBackupName);
    if (matches.length !== 1) throw new SafetyGateError("Expected exactly one recorded rollback backup for this release transition");
    const { backup, metadata } = matches[0]!;
    assertBackupRecord(backup, metadata);
    const detail = await this.api.getBackup(DATABASE_SCOPE.database, metadata.scope.branch, backup.id);
    assertBackupRecord(detail, metadata);
    return detail;
  }

  async manualRollbackTarget(report: ClassificationReport, expectedBackupName?: string): Promise<ManualRollbackTarget> {
    const backup = await this.assertBackupReady(report, expectedBackupName);
    const metadata = parseBackupName(backup.name);
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

  private async waitForBackup(
    report: ClassificationReport,
    name: string,
    branchName: string,
    initial: BackupRecord,
  ): Promise<BackupRecord> {
    let backup = initial;
    const wait = { ...defaultWait, ...this.waitOptions };
    const deadline = wait.now() + wait.timeoutMs;
    while (true) {
      if (backup.name !== name) throw new SafetyGateError("PlanetScale returned a backup with an unexpected name");
      if (backup.state === "success") {
        let current = backup;
        if (!current.protected) current = await this.api.protectBackup(DATABASE_SCOPE.database, branchName, current.id);
        if (current.state !== "success" || !current.protected)
          throw new SafetyGateError("PlanetScale backup completed but could not be protected");
        current = await this.api.getBackup(DATABASE_SCOPE.database, branchName, current.id);
        const metadata = parseBackupName(current.name);
        assertBackupMatchesReport(metadata, report);
        assertBackupRecord(current, metadata);
        return current;
      }
      if (backup.state !== "pending" && backup.state !== "running")
        throw new SafetyGateError(`PlanetScale backup ended in state ${backup.state}`);
      if (wait.now() >= deadline) throw new SafetyGateError("PlanetScale backup did not complete before the safety timeout");
      await wait.sleep(wait.pollIntervalMs);
      backup = await this.api.getBackup(DATABASE_SCOPE.database, branchName, backup.id);
    }
  }

  private async findMatchingBackups(report: ClassificationReport, expectedBackupName?: string): Promise<Array<{ backup: BackupRecord; metadata: BackupMetadata }>> {
    const databaseMatches = await this.api.listDatabases(DATABASE_SCOPE.database);
    if (!databaseMatches.some((database) => database.name === DATABASE_SCOPE.database && database.kind === "postgresql"))
      throw new SafetyGateError("PlanetScale production database is not available for rollback");

    const matches: Array<{ backup: BackupRecord; metadata: BackupMetadata }> = [];
    const branches = await this.api.listBranches(DATABASE_SCOPE.database);
    for (const branch of branches) {
      if (branch.kind !== "postgresql") continue;
      for (const backup of await this.api.listBackups(DATABASE_SCOPE.database, branch.name)) {
        if (!backup.name.startsWith("basalt-release-v1-")) continue;
        const metadata = parseBackupName(backup.name);
        if ((!expectedBackupName || backup.name === expectedBackupName) && backupMatchesReport(metadata, report))
          matches.push({ backup, metadata });
      }
    }
    return matches;
  }
}

export function backupMatchesReport(metadata: BackupMetadata, report: ClassificationReport): boolean {
  return metadata.base.gitCommit === report.base.gitCommit &&
    metadata.candidate.gitCommit === report.candidate.gitCommit &&
    stableStringify(metadata.base.pins) === stableStringify(summarizePins(report.base.pins)) &&
    stableStringify(metadata.candidate.pins) === stableStringify(summarizePins(report.candidate.pins)) &&
    metadata.scope.provider === DATABASE_SCOPE.provider &&
    metadata.scope.database === DATABASE_SCOPE.database &&
    DATABASE_SCOPE.logicalDatabases.every((database) => metadata.scope.logicalDatabases.includes(database));
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
