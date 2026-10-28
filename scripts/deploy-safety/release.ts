import { appendFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCurrentRelease, classifyManualRollbackCandidate, currentCommit, latestProductionBase, verifyFreshManualRollbackReport, verifyFreshReport, gitRepositoryRoot } from "./release-plan.ts";
import { assertWorkflowsDrained, inspectWorkflowChange } from "./cloudflare.ts";
import { parseReportFile, reportDigest, SafetyGateError } from "./contracts.ts";
import { releaseBackup } from "./github-ledger.ts";
import { PlanetScaleSafety } from "./planetscale-safety.ts";
import { executeManualRollback, executeRelease, productionManualRollbackDependencies, productionReleaseDependencies, resolveCandidateSourceRoot, type ReleaseMode } from "./release-runner.ts";
import { requireCloudflareEnvironment, requirePlanetScaleEnvironment } from "./runtime.ts";

export type ReleaseCliOptions = { [key: string]: string };

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const options = parseOptions(rest);

  if (command === "latest-base") {
    const result = await latestProductionBase();
    writeActionOutputs({
      ledger_state: result.state,
      ...(result.baseGitCommit ? { base_git_commit: result.baseGitCommit } : {}),
      ...(result.deploymentId ? { latest_deployment_id: String(result.deploymentId) } : {}),
      ...(result.deploymentStatus ? { latest_deployment_status: result.deploymentStatus } : {}),
    });
    print(result);
    return;
  }

  if (command === "report") {
    const checkout = candidateCheckout(options, true);
    const plan = await classifyCurrentRelease(checkout.commit);
    const value = {
      ...plan.report,
      deployable: plan.ledger.state === "ready" || plan.ledger.state === "uninitialized",
      manualRequired: plan.manualRequired,
      latestDeploymentState: plan.ledger.state,
    };
    writeActionOutputs({
      database_changed: String(plan.report.databaseChanged),
      workflow_changed: String(plan.report.workflowChanged),
      manual_required: String(plan.manualRequired),
      base_git_commit: plan.report.base.gitCommit,
      candidate_git_commit: plan.report.candidate.gitCommit,
      report_digest: reportDigest(plan.report),
    });
    print(value);
    return;
  }

  if (command === "rollback-report") {
    const candidate = candidateCheckout(options).commit;
    const plan = await classifyManualRollbackCandidate(candidate);
    if (plan.ledger.state === "uninitialized")
      throw new SafetyGateError("Rollback report requires the current production deployment record");
    const deploymentState = plan.ledger.state === "ready" ? "success" : plan.ledger.deploymentStatus;
    writeActionOutputs({
      base_git_commit: plan.report.base.gitCommit,
      candidate_git_commit: plan.report.candidate.gitCommit,
      current_deployment_id: String(plan.ledger.deploymentId),
      current_deployment_status: deploymentState,
      database_changed: String(plan.report.databaseChanged),
      workflow_changed: String(plan.report.workflowChanged),
      report_digest: reportDigest(plan.report),
    });
    print(plan.report);
    return;
  }

  if (command === "backup-only") {
    const candidate = candidateCheckout(options).commit;
    const plan = await verifyFreshReport(parseReportFile(required(options, "--report")), candidate);
    requireManualDispatchIfRisky(plan.manualRequired);
    const result = await new PlanetScaleSafety(requirePlanetScaleEnvironment())
      .ensureBackup(plan.report, plan.ledger.state === "uninitialized");
    writeActionOutputs({
      database_backup_state: result.state,
      ...(result.state === "ready" ? { database_backup_id: result.backupId, database_backup_name: result.backupName } : {}),
      report_digest: reportDigest(plan.report),
    });
    print(result);
    return;
  }

  if (command === "inspect-workflows") {
    const plan = await verifyFreshReport(parseReportFile(required(options, "--report")), candidateCheckout(options).commit);
    const snapshot = await inspectWorkflowChange(plan.report, requireCloudflareEnvironment());
    const statusCounts: Record<string, number> = {};
    for (const instance of snapshot.unresolved)
      statusCounts[instance.status] = (statusCounts[instance.status] ?? 0) + 1;
    const result = {
      workflowCount: snapshot.workflowCount,
      instanceCount: snapshot.instanceCount,
      unresolvedCount: snapshot.unresolved.length,
      unresolvedByStatus: statusCounts,
      manualQuiescenceRequired: snapshot.manualQuiescenceRequired,
    };
    writeActionOutputs({
      workflow_manual_quiescence_required: String(snapshot.manualQuiescenceRequired),
      workflow_unresolved_count: String(snapshot.unresolved.length),
    });
    print(result);
    assertWorkflowsDrained(snapshot);
    return;
  }

  if (command === "rollback-target") {
    const plan = await verifyFreshManualRollbackReport(
      parseReportFile(required(options, "--report")),
      candidateCheckout(options).commit,
      parseDeploymentId(required(options, "--deployment-id")),
    );
    if (!plan.report.databaseChanged) {
      print({ manualRestoreRequired: false, reason: "database-unchanged" });
      return;
    }
    const target = await new PlanetScaleSafety(requirePlanetScaleEnvironment()).manualRollbackTarget(plan.report, releaseBackup(plan.ledger));
    // Optional here so the target can be read before restoring; the rollback workflow always passes it.
    if (options["--restored-backup"] !== undefined) assertRestoredBackup(options["--restored-backup"], target.backupName);
    writeActionOutputs({ manual_restore_required: "true", rollback_backup_id: target.backupId, rollback_backup_name: target.backupName });
    print(target);
    return;
  }

  if (command === "manual-rollback") {
    const candidate = candidateCheckout(options).commit;
    const expectedDeploymentId = parseDeploymentId(required(options, "--deployment-id"));
    const plan = await verifyFreshManualRollbackReport(
      parseReportFile(required(options, "--report")), candidate, expectedDeploymentId,
    );
    if (plan.report.databaseChanged)
      assertRestoredBackup(required(options, "--restored-backup"), releaseBackup(plan.ledger).name);
    const rollbackRoot = resolveManualRollbackSourceRoot(
      plan.report.base.gitCommit,
      options["--rollback-root"],
      options["--candidate-root"],
    );
    const result = await executeManualRollback(
      plan.report,
      expectedDeploymentId,
      productionManualRollbackDependencies(rollbackRoot, plan.report.base.gitCommit, plan.ledger),
    );
    writeActionOutputs({ rollback_state: "success", deployment_state: "success" });
    print(result);
    return;
  }

  if (command === "deploy") {
    const mode = parseMode(required(options, "--mode"));
    const candidateSha = required(options, "--candidate").trim().toLowerCase();
    const candidateRoot = resolveCandidateSourceRoot(mode, candidateSha, options["--candidate-root"]);
    const candidate = candidateCheckout(options, mode === "automatic").commit;
    const plan = await verifyFreshReport(parseReportFile(required(options, "--report")), candidate);
    if (plan.ledger.state === "unresolved")
      throw new SafetyGateError("Latest production deployment is unresolved; reconcile it before another release");
    const dependencies = productionReleaseDependencies(candidateRoot, candidate);
    const priorBegin = dependencies.begin;
    dependencies.begin = async (report, backup) => {
      const id = await priorBegin(report, backup);
      writeActionOutputs({ deployment_id: String(id), deployment_state: "in_progress" });
      return id;
    };
    const result = await executeRelease(plan.report, mode, dependencies);
    writeActionOutputs({ deployment_state: "success" });
    print(result);
    return;
  }

  throw new SafetyGateError("Usage: release.ts <latest-base|report|rollback-report|backup-only|inspect-workflows|rollback-target|manual-rollback|deploy> [options]");
}

export function candidateCheckout(options: ReleaseCliOptions, allowTrustedMainBootstrap = false): { root: string; commit: string } {
  let root: string;
  try {
    root = realpathSync(options["--candidate-root"] ?? process.cwd());
  } catch {
    throw new SafetyGateError("Candidate checkout is unavailable");
  }
  const configured = options["--candidate"]?.trim().toLowerCase();
  if (!configured) throw new SafetyGateError("Missing required option --candidate");
  const commit = currentCommit(root);
  if (configured !== commit)
    throw new SafetyGateError("Candidate SHA does not match the checked-out HEAD");

  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    if (process.env.GITHUB_REF !== "refs/heads/main")
      throw new SafetyGateError("Manual candidate checkout requires workflow_dispatch from trusted main");
    const runnerTemp = process.env.RUNNER_TEMP;
    let candidateIsUnderRunnerTemp = false;
    if (runnerTemp) {
      try {
        candidateIsUnderRunnerTemp = isPathInside(root, realpathSync(runnerTemp));
      } catch {
        candidateIsUnderRunnerTemp = false;
      }
    }
    let isTrustedBootstrap = false;
    if (allowTrustedMainBootstrap && !options["--candidate-root"]) {
      try {
        isTrustedBootstrap = root === realpathSync(gitRepositoryRoot()) &&
          configured === process.env.GITHUB_SHA?.trim().toLowerCase();
      } catch {
        isTrustedBootstrap = false;
      }
    }
    if (!candidateIsUnderRunnerTemp && !isTrustedBootstrap)
      throw new SafetyGateError("Manual candidate checkout must be a separate worktree under RUNNER_TEMP");
  }
  return { root, commit };
}

function isPathInside(path: string, parent: string): boolean {
  const pathFromParent = relative(parent, path);
  return pathFromParent !== "" && pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent);
}

/** No one approves a rollback, so whoever dispatches names the backup they restored; it must be the recorded one. */
export function assertRestoredBackup(restored: string, recorded: string): void {
  if (restored.trim() !== recorded)
    throw new SafetyGateError(`--restored-backup must be this release's recorded backup, ${recorded}; restore that exact backup first`);
}

export function resolveManualRollbackSourceRoot(
  expectedCommit: string,
  requestedRoot: string | undefined,
  failedCandidateRoot: string | undefined,
  runnerTemp = process.env.RUNNER_TEMP,
): string {
  if (!runnerTemp) throw new SafetyGateError("Manual rollback source requires RUNNER_TEMP");
  let rollbackRoot: string;
  let failedRoot: string;
  let allowedRoot: string;
  try {
    rollbackRoot = realpathSync(requestedRoot ?? "");
    failedRoot = realpathSync(failedCandidateRoot ?? "");
    allowedRoot = realpathSync(runnerTemp);
  } catch {
    throw new SafetyGateError("Manual rollback worktree is unavailable");
  }
  if (!isPathInside(rollbackRoot, allowedRoot) || !isPathInside(failedRoot, allowedRoot))
    throw new SafetyGateError("Manual rollback and failed-candidate worktrees must be under RUNNER_TEMP");
  if (rollbackRoot === failedRoot || isPathInside(rollbackRoot, failedRoot) || isPathInside(failedRoot, rollbackRoot))
    throw new SafetyGateError("Manual rollback source must be separate from the failed candidate worktree");
  if (currentCommit(rollbackRoot) !== expectedCommit.toLowerCase())
    throw new SafetyGateError("Manual rollback source HEAD does not match the recorded production baseline");
  return rollbackRoot;
}

function parseOptions(args: string[]): ReleaseCliOptions {
  const options: ReleaseCliOptions = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (!key.startsWith("--")) throw new SafetyGateError("Unexpected positional argument");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new SafetyGateError(`Missing value for ${key}`);
    if (options[key] !== undefined) throw new SafetyGateError(`Duplicate option ${key}`);
    if (!new Set(["--report", "--candidate", "--mode", "--candidate-root", "--rollback-root", "--deployment-id", "--restored-backup"]).has(key))
      throw new SafetyGateError(`Unknown option ${key}`);
    options[key] = value;
  }
  return options;
}

function required(options: ReleaseCliOptions, name: string): string {
  const value = options[name];
  if (!value) throw new SafetyGateError(`Missing required option ${name}`);
  return value;
}

function parseMode(value: string): ReleaseMode {
  if (value !== "automatic" && value !== "manual") throw new SafetyGateError("Release mode must be automatic or manual");
  return value;
}

function parseDeploymentId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new SafetyGateError("Production deployment id is invalid");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new SafetyGateError("Production deployment id is invalid");
  return id;
}

function requireManualDispatchIfRisky(manualRequired: boolean): void {
  if (manualRequired && (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_REF !== "refs/heads/main"))
    throw new SafetyGateError("Database-changing and Workflow-identity candidates require workflow_dispatch from trusted main");
}

function writeActionOutputs(values: Record<string, string>): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const entries = Object.entries(values);
  if (entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(value)))
    throw new SafetyGateError("Action outputs contain an invalid key or value");
  appendFileSync(path, entries.map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Release safety command failed"}\n`);
    process.exitCode = 1;
  }
}
