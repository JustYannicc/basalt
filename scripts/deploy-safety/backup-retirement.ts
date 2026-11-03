import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { backupRetirementReport, type BackupInventory } from "./backup-retirement-policy.ts";
import { DATABASE_SCOPE, SafetyGateError, stableStringify } from "./contracts.ts";
import { readBackupDeploymentHistory, type LedgerEnvironment } from "./github-ledger.ts";
import type { Fetcher } from "./http.ts";
import { PlanetScaleApi, type PlanetScaleCredentials } from "./planetscale-api.ts";
import { requireGithubEnvironment, requirePlanetScaleEnvironment } from "./runtime.ts";

export async function readBackupRetirementReport(
  credentials: PlanetScaleCredentials,
  github: LedgerEnvironment,
  keepReview?: unknown,
  fetcher: Fetcher = fetch,
  now: () => number = Date.now,
) {
  const readOnlyFetch: Fetcher = (input, init) => {
    if (init?.method !== "GET") throw new SafetyGateError("Backup retirement reports only permit GET requests");
    return fetcher(input, init);
  };
  const api = new PlanetScaleApi(credentials, readOnlyFetch);
  const database = await api.getDatabase(DATABASE_SCOPE.database);
  if (database.name !== DATABASE_SCOPE.database || database.kind !== "postgresql" || !database.ready)
    throw new SafetyGateError("Production backup database is not verified");
  const branches = (await api.listBranches(database.name)).filter(branch => branch.production);
  if (!branches.some(branch => branch.name === database.default_branch) ||
      new Set(branches.map(branch => branch.id)).size !== branches.length || new Set(branches.map(branch => branch.name)).size !== branches.length)
    throw new SafetyGateError("Production backup branches are missing or ambiguous");
  const inventory: BackupInventory = { organization: credentials.organization, database: database.name, branches: [] };
  const seen = new Set<string>();
  for (const branch of branches.sort((left, right) => left.name.localeCompare(right.name))) {
    const backups = [];
    for (const listed of await api.listBackups(database.name, branch.name)) {
      if (seen.has(listed.id)) throw new SafetyGateError("Production backup inventory contains duplicate IDs");
      seen.add(listed.id);
      const detail = await api.getBackup(database.name, branch.name, listed.id);
      if (detail.id !== listed.id || detail.name !== listed.name) throw new SafetyGateError("Production backup identity changed during inventory");
      backups.push(detail);
    }
    backups.sort((left, right) => left.id.localeCompare(right.id));
    inventory.branches.push({ branch, backups });
  }
  const history = await readBackupDeploymentHistory(github, readOnlyFetch);
  return backupRetirementReport(inventory, history, now(), keepReview);
}

export async function main(args: string[]): Promise<void> {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--keep-review" || !args[1]))
    throw new SafetyGateError("Usage: backup-retirement.ts [--keep-review <private-json-file>]");
  let keepReview: unknown;
  if (args[1]) {
    try { keepReview = JSON.parse(readFileSync(args[1], "utf8")); }
    catch { throw new SafetyGateError("Keep-review file cannot be read or parsed"); }
  }
  const report = await readBackupRetirementReport(requirePlanetScaleEnvironment(), requireGithubEnvironment(), keepReview);
  console.log(stableStringify(report));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof SafetyGateError ? error.message : "Backup retirement report failed");
    process.exitCode = 1;
  }
}
