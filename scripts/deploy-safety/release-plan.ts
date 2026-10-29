import { execFileSync, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRefs } from "../releases/classify.ts";
import { GitHubApi } from "../releases/github.ts";
import type { ClassificationReport } from "../releases/types.ts";
import {
  assertManualRollbackCandidate,
  assertReportUsesLatestDeploy,
  keepRollForwardGates,
  readDeploymentLedger,
  readLedgerEnvironment,
  type DeploymentLedger,
  type RollForward,
} from "./github-ledger.ts";
import { SafetyGateError, stableStringify, type PinSummary } from "./contracts.ts";
import { PlanetScaleSafety } from "./planetscale-safety.ts";
import { assertNoReleaseHold, requirePlanetScaleEnvironment } from "./runtime.ts";

export type ReleasePlan = {
  report: ClassificationReport;
  ledger: DeploymentLedger;
  manualRequired: boolean;
};

const trustedRepositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Whether `descendant` contains `ancestor`, by `git merge-base --is-ancestor` in the trusted
 * checkout. Git exits 0 when it is an ancestor and 1 when it is not; anything else, such as a
 * commit missing from the checkout, throws.
 */
export function gitContains(repositoryRoot = trustedRepositoryRoot): RollForward["contains"] {
  return (ancestor, descendant) => {
    if (![ancestor, descendant].every((commit) => /^[a-f0-9]{40}$/.test(commit)))
      throw new SafetyGateError("Commit ancestry needs exact commit SHAs");
    const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new SafetyGateError(`git could not compare ${ancestor} with ${descendant}`);
  };
}

/**
 * Lets a release of `candidateGitCommit` roll forward over a failed release whose commit it
 * contains. A commit Git can't find or compare throws, so the failure stays unresolved. Rollback
 * paths read the ledger without it.
 */
export function rollForwardTo(candidateGitCommit: string, repositoryRoot = trustedRepositoryRoot): RollForward {
  return { candidateGitCommit, contains: gitContains(repositoryRoot) };
}

/**
 * The last successful production commit when it is `candidate` or contains it, so releasing the
 * candidate would move production backwards. Check runs can finish out of order, so an older
 * candidate's release can start after a newer one has gone live.
 */
export function liveCommitContaining(
  candidate: string,
  ledger: DeploymentLedger,
  contains: RollForward["contains"],
): string | undefined {
  const live = ledger.state === "ready" ? ledger.gitCommit : ledger.state === "unresolved" ? ledger.lastSuccessful?.gitCommit : undefined;
  return live && (live === candidate || contains(candidate, live)) ? live : undefined;
}

export async function productionCommitContaining(candidate: string, repositoryRoot = trustedRepositoryRoot): Promise<string | undefined> {
  const ledger = await readDeploymentLedger(readLedgerEnvironment());
  const contains = gitContains(repositoryRoot);
  return liveCommitContaining(candidate, ledger, (ancestor, descendant) => {
    // A `Manual release` of a pull request records its head commit, which a main checkout lacks.
    if (spawnSync("git", ["cat-file", "-e", `${descendant}^{commit}`], { cwd: repositoryRoot, stdio: "ignore" }).status !== 0)
      execFileSync("git", ["fetch", "--quiet", "--no-tags", "origin", descendant], { cwd: repositoryRoot, stdio: ["ignore", "ignore", "pipe"] });
    return contains(ancestor, descendant);
  });
}

export async function latestProductionBase(): Promise<{
  state: "uninitialized" | "ready" | "unresolved";
  baseGitCommit?: string;
  pins?: PinSummary;
  deploymentId?: number;
  deploymentStatus?: string;
}> {
  const environment = readLedgerEnvironment();
  const ledger = await readDeploymentLedger(environment);
  if (ledger.state === "uninitialized") {
    await new PlanetScaleSafety(requirePlanetScaleEnvironment()).assertInitialDatabaseAbsent(ledger.attempts);
    return { state: "uninitialized" };
  }
  if (ledger.state === "ready")
    return { state: "ready", baseGitCommit: ledger.gitCommit, pins: ledger.pins, deploymentId: ledger.deploymentId };
  const lastSuccessful = ledger.lastSuccessful;
  return {
    state: "unresolved",
    ...(lastSuccessful ? { baseGitCommit: lastSuccessful.gitCommit, pins: lastSuccessful.pins } : {}),
    deploymentId: ledger.deploymentId,
    deploymentStatus: ledger.deploymentStatus,
  };
}

export async function classifyCurrentRelease(candidateRef = currentCommit()): Promise<ReleasePlan> {
  assertNoReleaseHold();
  const ledgerEnvironment = readLedgerEnvironment();
  const ledger = await readDeploymentLedger(ledgerEnvironment, fetch, rollForwardTo(candidateRef));
  let baseCommit: string;
  if (ledger.state === "ready") baseCommit = ledger.gitCommit;
  else if (ledger.state === "unresolved" && ledger.lastSuccessful) baseCommit = ledger.lastSuccessful.gitCommit;
  else if (ledger.state === "uninitialized") {
    await new PlanetScaleSafety(requirePlanetScaleEnvironment()).assertInitialDatabaseAbsent(ledger.attempts);
    baseCommit = candidateRef;
  } else {
    throw new SafetyGateError("Production has no successful deployment baseline; reconcile it before classifying a release");
  }

  const api = new GitHubApi(ledgerEnvironment.token);
  const report = await classifyRefs(trustedRepositoryRoot, baseCommit, candidateRef, api);
  if (report.base.gitCommit !== baseCommit || report.candidate.gitCommit !== candidateRef)
    throw new SafetyGateError("Release classifier did not return the requested exact commits");
  return { report, ledger: keepRollForwardGates(ledger, report), manualRequired: report.databaseChanged || report.workflowChanged };
}

export async function classifyManualRollbackCandidate(candidateRef: string): Promise<ReleasePlan> {
  const environment = readLedgerEnvironment();
  const ledger = await readDeploymentLedger(environment);
  if (ledger.state === "uninitialized" || ledger.gitCommit !== candidateRef)
    throw new SafetyGateError("Rollback candidate does not match the latest production deployment");
  const baseCommit = manualRollbackBaselineCommit(ledger);
  const report = await classifyRefs(trustedRepositoryRoot, baseCommit, candidateRef, new GitHubApi(environment.token));
  assertManualRollbackCandidate(report, ledger);
  return { report, ledger, manualRequired: report.databaseChanged || report.workflowChanged };
}

export async function verifyFreshReport(
  report: ClassificationReport,
  expectedCandidate = currentCommit(),
): Promise<ReleasePlan> {
  const fresh = await reclassifyReport(report, expectedCandidate);
  assertReportUsesLatestDeploy(report, fresh.ledger);
  return fresh;
}

export async function verifyFreshManualRollbackReport(
  report: ClassificationReport,
  expectedCandidate = report.candidate.gitCommit,
  expectedDeploymentId?: number,
): Promise<ReleasePlan> {
  if (report.candidate.gitCommit !== expectedCandidate)
    throw new SafetyGateError("Manual rollback report candidate does not match the expected commit");
  const environment = readLedgerEnvironment();
  const ledger = await readDeploymentLedger(environment);
  if (expectedDeploymentId !== undefined && (!Number.isSafeInteger(expectedDeploymentId) || expectedDeploymentId < 1 ||
      ledger.state === "uninitialized" || ledger.deploymentId !== expectedDeploymentId))
    throw new SafetyGateError("Production deployment changed after the rollback plan was prepared");
  assertManualRollbackCandidate(report, ledger);
  const baseCommit = manualRollbackBaselineCommit(ledger);
  if (report.base.gitCommit !== baseCommit)
    throw new SafetyGateError("Manual rollback report base does not match the recorded production baseline");
  const freshReport = await classifyRefs(trustedRepositoryRoot, baseCommit, expectedCandidate, new GitHubApi(environment.token));
  if (stableStringify(freshReport) !== stableStringify(report))
    throw new SafetyGateError("Manual rollback classification changed since it was produced");
  assertManualRollbackCandidate(freshReport, ledger);
  return {
    report: freshReport,
    ledger,
    manualRequired: freshReport.databaseChanged || freshReport.workflowChanged,
  };
}

export function manualRollbackBaselineCommit(ledger: DeploymentLedger): string {
  if (ledger.state === "ready" && ledger.payload.kind === "release") {
    if (ledger.payload.baseGitCommit === ledger.payload.candidateGitCommit)
      throw new SafetyGateError("Manual rollback has no prior successful production baseline");
    return ledger.payload.baseGitCommit;
  }
  if (ledger.state === "unresolved" &&
      (ledger.deploymentStatus === "failure" || ledger.deploymentStatus === "error") &&
      ledger.lastSuccessful)
    return ledger.lastSuccessful.gitCommit;
  throw new SafetyGateError("Manual rollback requires the baseline of a completed production release");
}

async function reclassifyReport(
  report: ClassificationReport,
  expectedCandidate: string,
): Promise<ReleasePlan> {
  if (report.candidate.gitCommit !== expectedCandidate)
    throw new SafetyGateError("Classification report candidate does not match the checked-out commit");
  const fresh = await classifyCurrentRelease(expectedCandidate);
  if (stableStringify(fresh.report) !== stableStringify(report))
    throw new SafetyGateError("Classification report changed since it was produced; regenerate it at the current production baseline");
  return fresh;
}

export function currentCommit(repositoryRoot = process.cwd()): string {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new SafetyGateError("Current release commit is not an immutable SHA");
  const head = commit.toLowerCase();
  const expected = process.env.BASALT_RELEASE_CANDIDATE_SHA?.trim().toLowerCase();
  if (expected && expected !== head)
    throw new SafetyGateError("BASALT_RELEASE_CANDIDATE_SHA does not match the checked-out HEAD");
  return head;
}

export function gitRepositoryRoot(): string {
  return trustedRepositoryRoot;
}
