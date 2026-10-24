import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRefs } from "../releases/classify.ts";
import { GitHubApi } from "../releases/github.ts";
import type { ClassificationReport } from "../releases/types.ts";
import {
  assertManualRollbackCandidate,
  assertReportUsesLatestDeploy,
  readDeploymentLedger,
  readLedgerEnvironment,
  type DeploymentLedger,
} from "./github-ledger.ts";
import { SafetyGateError, stableStringify, type PinSummary } from "./contracts.ts";
import { PlanetScaleSafety } from "./planetscale-safety.ts";
import { requirePlanetScaleEnvironment } from "./runtime.ts";

export type ReleasePlan = {
  report: ClassificationReport;
  ledger: DeploymentLedger;
  manualRequired: boolean;
};

const trustedRepositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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
    await new PlanetScaleSafety(requirePlanetScaleEnvironment()).assertInitialDatabaseAbsent();
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
  const ledgerEnvironment = readLedgerEnvironment();
  const ledger = await readDeploymentLedger(ledgerEnvironment);
  let baseCommit: string;
  if (ledger.state === "ready") baseCommit = ledger.gitCommit;
  else if (ledger.state === "unresolved" && ledger.lastSuccessful) baseCommit = ledger.lastSuccessful.gitCommit;
  else if (ledger.state === "uninitialized") {
    await new PlanetScaleSafety(requirePlanetScaleEnvironment()).assertInitialDatabaseAbsent();
    baseCommit = candidateRef;
  } else {
    throw new SafetyGateError("Production has no successful deployment baseline; reconcile it before classifying a release");
  }

  const api = new GitHubApi(ledgerEnvironment.token);
  const report = await classifyRefs(trustedRepositoryRoot, baseCommit, candidateRef, api);
  if (report.base.gitCommit !== baseCommit || report.candidate.gitCommit !== candidateRef)
    throw new SafetyGateError("Release classifier did not return the requested exact commits");
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
): Promise<ReleasePlan> {
  if (report.candidate.gitCommit !== expectedCandidate)
    throw new SafetyGateError("Manual rollback report candidate does not match the expected commit");
  const environment = readLedgerEnvironment();
  const ledger = await readDeploymentLedger(environment);
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
