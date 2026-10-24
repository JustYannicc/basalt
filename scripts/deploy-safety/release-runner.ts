import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClassificationReport } from "../releases/types.ts";
import { SafetyGateError } from "./contracts.ts";
import { assertManualRollbackCandidate, beginReleaseDeployment, beginRollbackDeployment, finishDeployment, readDeploymentLedger, readLedgerEnvironment } from "./github-ledger.ts";
import { PlanetScaleSafety } from "./planetscale-safety.ts";
import { requirePlanetScaleEnvironment } from "./runtime.ts";

export type ReleaseMode = "automatic" | "manual";

export type CommandResult = { started: boolean; exitCode: number | null };

export type ReleaseDependencies = {
  validateCredentials(): void;
  assertBackup(report: ClassificationReport): Promise<void>;
  begin(report: ClassificationReport): Promise<number>;
  mark(deploymentId: number, state: "success" | "failure"): Promise<void>;
  deploy(): Promise<CommandResult>;
  smoke(): Promise<CommandResult>;
  rollback(report: ClassificationReport): Promise<void>;
};

export type ReleaseResult = {
  state: "deployed" | "rolled-back";
  deploymentId: number;
  rollbackDeploymentId?: number;
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function executeRelease(
  report: ClassificationReport,
  mode: ReleaseMode,
  dependencies: ReleaseDependencies,
): Promise<ReleaseResult> {
  assertReleaseMode(report, mode);
  dependencies.validateCredentials();
  if (report.databaseChanged) await dependencies.assertBackup(report);

  const deploymentId = await dependencies.begin(report);
  const deploy = await dependencies.deploy();
  if (!deploy.started) {
    await dependencies.mark(deploymentId, "failure");
    throw new SafetyGateError("Production deployment process did not start; no rollback was attempted");
  }
  if (deploy.exitCode !== 0)
    return recoverAfterAttempt(report, mode, dependencies, deploymentId, "deployment command failed");

  const smoke = await dependencies.smoke();
  if (!smoke.started || smoke.exitCode !== 0)
    return recoverAfterAttempt(report, mode, dependencies, deploymentId, "production smoke check failed");

  await dependencies.mark(deploymentId, "success");
  return { state: "deployed", deploymentId };
}

export function assertReleaseMode(
  report: ClassificationReport,
  mode: ReleaseMode,
  eventName = process.env.GITHUB_EVENT_NAME,
  ref = process.env.GITHUB_REF,
): void {
  const manualRequired = report.databaseChanged || report.workflowChanged;
  if (manualRequired && mode !== "manual")
    throw new SafetyGateError("Database-changing and Workflow-identity releases require manual release mode");
  if (mode === "manual" && (eventName !== "workflow_dispatch" || ref !== "refs/heads/main"))
    throw new SafetyGateError("Manual release mode requires workflow_dispatch from trusted main");
  if (mode === "automatic" && ((eventName !== "push" && eventName !== "workflow_dispatch") || ref !== "refs/heads/main"))
    throw new SafetyGateError("Automatic release mode is available only to main branch push or bootstrap dispatch workflows");
}

export function productionReleaseDependencies(sourceRoot = repositoryRoot, candidateCommit?: string): ReleaseDependencies {
  const github = readLedgerEnvironment();
  const planetscale = new PlanetScaleSafety(requirePlanetScaleEnvironment());
  return {
    validateCredentials: () => validateCandidateSource(sourceRoot, candidateCommit),
    assertBackup: async (report) => {
      const target = await planetscale.assertBackupReady(report);
      if (target.state !== "success" || !target.protected)
        throw new SafetyGateError("PlanetScale rollback backup is not both complete and protected");
    },
    begin: (report) => beginReleaseDeployment(report, github),
    mark: (deploymentId, state) => finishDeployment(deploymentId, state, github),
    deploy: () => runCommand("npm", ["run", "deploy"], sourceRoot),
    smoke: () => runCommand("node", ["scripts/smoke.ts"], repositoryRoot),
    rollback: (report) => deployPreviousRelease(report, github),
  };
}

export function resolveCandidateSourceRoot(
  mode: ReleaseMode,
  candidateCommit: string,
  requestedRoot?: string,
  runnerTemp = process.env.RUNNER_TEMP,
): string {
  if (mode === "automatic") {
    if (requestedRoot) throw new SafetyGateError("Automatic releases use the checked-out main source");
    const sourceRoot = realpathSync(process.cwd());
    validateCandidateSource(sourceRoot, candidateCommit);
    const workflowSha = process.env.GITHUB_SHA?.trim().toLowerCase();
    if (workflowSha && workflowSha !== candidateCommit.toLowerCase())
      throw new SafetyGateError("Automatic release candidate does not match GitHub's push SHA");
    return sourceRoot;
  }
  if (!runnerTemp) throw new SafetyGateError("Manual candidate validation requires RUNNER_TEMP");
  let candidateRoot: string;
  let allowedRoot: string;
  try {
    candidateRoot = realpathSync(requestedRoot ?? process.cwd());
    allowedRoot = realpathSync(runnerTemp);
  } catch {
    throw new SafetyGateError("Manual candidate source directory is unavailable");
  }
  if (!candidateRoot.startsWith(`${allowedRoot}/`))
    throw new SafetyGateError("Manual candidate source must be inside RUNNER_TEMP");
  validateCandidateSource(candidateRoot, candidateCommit);
  return candidateRoot;
}

function validateCandidateSource(sourceRoot: string, candidateCommit?: string): void {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new SafetyGateError("Production deployment runs only in GitHub Actions");
  let head: string;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .toLowerCase();
  } catch {
    throw new SafetyGateError("Candidate source directory is not a Git worktree");
  }
  if (!/^[a-f0-9]{40}$/.test(head) || (candidateCommit && head !== candidateCommit.toLowerCase()))
    throw new SafetyGateError("Candidate source HEAD does not match the classified commit");

  const validation = spawnSync(
    "node",
    ["--input-type=module", "-e", 'import { deployEnvironment } from "./scripts/environment.ts"; deployEnvironment();'],
    { cwd: sourceRoot, env: process.env, stdio: "ignore" },
  );
  if (validation.error || validation.status !== 0)
    throw new SafetyGateError("Candidate deployment credentials or configuration failed validation");
}

export async function beginManualRollback(report: ClassificationReport): Promise<number> {
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_REF !== "refs/heads/main")
    throw new SafetyGateError("Manual rollback requires workflow_dispatch from trusted main");
  const environment = readLedgerEnvironment();
  const ledger = await readDeploymentLedger(environment);
  assertManualRollbackCandidate(report, ledger);
  if (report.databaseChanged) {
    const target = await new PlanetScaleSafety(requirePlanetScaleEnvironment()).manualRollbackTarget(report);
    if (!target.manualRestoreRequired)
      throw new SafetyGateError("Database rollback requires operator restoration before the old release deploy");
  }
  return beginRollbackDeployment(report, environment);
}

async function recoverAfterAttempt(
  report: ClassificationReport,
  mode: ReleaseMode,
  dependencies: ReleaseDependencies,
  deploymentId: number,
  reason: string,
): Promise<ReleaseResult> {
  await dependencies.mark(deploymentId, "failure");
  if (mode !== "automatic" || report.databaseChanged || report.workflowChanged)
    throw new SafetyGateError(`Production ${reason}; this release requires the manual rollback path`);
  if (report.base.gitCommit === report.candidate.gitCommit)
    throw new SafetyGateError(`Initial production ${reason}; no previous successful release exists for automatic rollback`);
  await dependencies.rollback(report);
  throw new SafetyGateError(`Production ${reason}; the previous safe release was redeployed successfully`);
}

async function deployPreviousRelease(
  report: ClassificationReport,
  github: ReturnType<typeof readLedgerEnvironment>,
): Promise<void> {
  const parent = mkdtempSync(join(tmpdir(), "basalt-release-recovery-"));
  const worktree = join(parent, "source");
  let added = false;
  let rollbackId: number | undefined;
  try {
    const fetched = await runCommand("git", ["fetch", "--no-tags", "origin", report.base.gitCommit], repositoryRoot);
    if (!fetched.started || fetched.exitCode !== 0) throw new SafetyGateError("Could not fetch the previous release source");
    const checkout = await runCommand("git", ["worktree", "add", "--detach", worktree, report.base.gitCommit], repositoryRoot);
    if (!checkout.started || checkout.exitCode !== 0) throw new SafetyGateError("Could not prepare the previous release source");
    added = true;

    const setup = [
      ["node", ["scripts/prepare-upstream.ts"]],
      ["npm", ["run", "check:upstream"]],
      ["npm", ["run", "build"]],
      ["npm", ["run", "check:build"]],
      ["npm", ["run", "typecheck"]],
    ] as const;
    for (const [command, args] of setup) {
      const result = await runCommand(command, [...args], worktree);
      if (!result.started || result.exitCode !== 0)
        throw new SafetyGateError("Previous release preparation or build failed; rollback deployment was not started");
    }

    rollbackId = await beginRollbackDeployment(report, github);
    const deploy = await runCommand("npm", ["run", "deploy"], worktree, {
      ...process.env,
      GITHUB_SHA: report.base.gitCommit,
    });
    if (!deploy.started) {
      await finishDeployment(rollbackId, "failure", github);
      throw new SafetyGateError("Previous release deployment process did not start");
    }
    if (deploy.exitCode !== 0) {
      await finishDeployment(rollbackId, "failure", github);
      throw new SafetyGateError("Previous release deployment failed");
    }

    const smoke = await runCommand("node", ["scripts/smoke.ts"], worktree);
    if (!smoke.started || smoke.exitCode !== 0) {
      await finishDeployment(rollbackId, "failure", github);
      throw new SafetyGateError("Previous release smoke check failed");
    }
    await finishDeployment(rollbackId, "success", github);
  } finally {
    if (added) await runCommand("git", ["worktree", "remove", "--force", worktree], repositoryRoot);
    rmSync(parent, { recursive: true, force: true });
  }
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let started = false;
    let settled = false;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
    child.once("spawn", () => { started = true; });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve({ started, exitCode: null });
      }
    });
    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ started, exitCode: code });
      }
    });
  });
}
