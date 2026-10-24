import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyCurrentRelease, currentCommit, latestProductionBase, verifyFreshManualRollbackReport, verifyFreshReport } from "./release-plan.ts";
import { inspectWorkflowChange } from "./cloudflare.ts";
import { parseReportFile, reportDigest, SafetyGateError } from "./contracts.ts";
import { PlanetScaleSafety } from "./planetscale-safety.ts";
import { beginManualRollback, executeRelease, productionReleaseDependencies, resolveCandidateSourceRoot, type ReleaseMode } from "./release-runner.ts";
import { requireCloudflareEnvironment, requirePlanetScaleEnvironment } from "./runtime.ts";

type Options = { [key: string]: string };

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
    const checkout = candidateCheckout(options);
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
    return;
  }

  if (command === "rollback-target") {
    const plan = await verifyFreshManualRollbackReport(parseReportFile(required(options, "--report")), candidateCheckout(options).commit);
    if (!plan.report.databaseChanged) {
      print({ manualRestoreRequired: false, reason: "database-unchanged" });
      return;
    }
    const target = await new PlanetScaleSafety(requirePlanetScaleEnvironment()).manualRollbackTarget(plan.report);
    writeActionOutputs({ manual_restore_required: "true", rollback_backup_id: target.backupId, rollback_backup_name: target.backupName });
    print(target);
    return;
  }

  if (command === "manual-rollback") {
    const plan = await verifyFreshManualRollbackReport(parseReportFile(required(options, "--report")), candidateCheckout(options).commit);
    requireManualDispatchIfRisky(true);
    const deploymentId = await beginManualRollback(plan.report);
    writeActionOutputs({ deployment_id: String(deploymentId), rollback_state: "in_progress" });
    print({ deploymentId, state: "in_progress", databaseRestore: plan.report.databaseChanged ? "manual-before-deploy" : "not-required" });
    return;
  }

  if (command === "deploy") {
    const mode = parseMode(required(options, "--mode"));
    const candidateRoot = resolveCandidateSourceRoot(mode, currentCommit(options["--candidate-root"] ?? process.cwd()), options["--candidate-root"]);
    const candidate = candidateCheckout({ ...options, "--candidate-root": candidateRoot }).commit;
    const plan = await verifyFreshReport(parseReportFile(required(options, "--report")), candidate);
    if (plan.ledger.state === "unresolved")
      throw new SafetyGateError("Latest production deployment is unresolved; reconcile it before another release");
    const dependencies = productionReleaseDependencies(candidateRoot, candidate);
    const priorBegin = dependencies.begin;
    dependencies.begin = async (report) => {
      const id = await priorBegin(report);
      writeActionOutputs({ deployment_id: String(id), deployment_state: "in_progress" });
      return id;
    };
    const result = await executeRelease(plan.report, mode, dependencies);
    writeActionOutputs({ deployment_state: "success" });
    print(result);
    return;
  }

  throw new SafetyGateError("Usage: release.ts <latest-base|report|backup-only|inspect-workflows|rollback-target|manual-rollback|deploy> [options]");
}

function candidateCheckout(options: Options): { root: string; commit: string } {
  let root: string;
  try {
    root = realpathSync(options["--candidate-root"] ?? process.cwd());
  } catch {
    throw new SafetyGateError("Candidate checkout is unavailable");
  }
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    const runnerTemp = process.env.RUNNER_TEMP;
    if (!runnerTemp || !root.startsWith(`${realpathSync(runnerTemp)}/`))
      throw new SafetyGateError("Manual candidate checkout must be a separate worktree under RUNNER_TEMP");
  }
  const commit = currentCommit(root);
  const configured = options["--candidate"]?.trim().toLowerCase();
  if (configured && configured !== commit)
    throw new SafetyGateError("Candidate SHA does not match the checked-out HEAD");
  return { root, commit };
}

function parseOptions(args: string[]): Options {
  const options: Options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (!key.startsWith("--")) throw new SafetyGateError("Unexpected positional argument");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new SafetyGateError(`Missing value for ${key}`);
    if (options[key] !== undefined) throw new SafetyGateError(`Duplicate option ${key}`);
    if (!new Set(["--report", "--candidate", "--mode", "--candidate-root"]).has(key))
      throw new SafetyGateError(`Unknown option ${key}`);
    options[key] = value;
  }
  return options;
}

function required(options: Options, name: string): string {
  const value = options[name];
  if (!value) throw new SafetyGateError(`Missing required option ${name}`);
  return value;
}

function parseMode(value: string): ReleaseMode {
  if (value !== "automatic" && value !== "manual") throw new SafetyGateError("Release mode must be automatic or manual");
  return value;
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
