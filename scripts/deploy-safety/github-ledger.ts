import { appendFileSync } from "node:fs";
import type { ClassificationReport } from "../releases/types.ts";
import {
  backupMatchesReport,
  parsePinSummary,
  reportDigest,
  SafetyGateError,
  stableStringify,
  summarizePins,
  verifyBackupMetadata,
  verifyReportBase,
  type BackupMetadata,
  type PinSummary,
  type RecordedBackup,
} from "./contracts.ts";
import { record, requestJson, stringField, withBearer, type Fetcher } from "./http.ts";

const apiOrigin = "https://api.github.com";
const pageSize = 100;
const maximumPages = 1000;
const systemName = "basalt-deploy-safety";

export type LedgerEnvironment = {
  token: string;
  repository: string;
};

export type DeploymentPayload = {
  system: typeof systemName;
  schemaVersion: 1;
  kind: "release" | "rollback";
  gitCommit: string;
  pins: PinSummary;
  basePins: PinSummary;
  baseGitCommit: string;
  candidateGitCommit: string;
  databaseChanged: boolean;
  workflowChanged: boolean;
  reportDigest: string;
  backupName?: string;
  /** The full metadata behind `backupName`'s digest. Parsing verifies it and fills it in for a legacy v1 name. */
  backupMetadata?: BackupMetadata;
  rollbackOf?: string;
};

export type AttemptWindow = { startedAt: string; endedAt: string };

/** A failed release attempt the ledger set aside because a later release may deploy over it. */
export type SupersededRelease = { deploymentId: number; gitCommit: string; deploymentStatus: string };

/**
 * Lets a release roll forward over a failed release it contains. `contains` answers whether
 * `ancestor` is `descendant` or one of its ancestors from real Git history, and throws when Git
 * can't answer.
 */
export type RollForward = {
  /** The commit being released now. */
  candidateGitCommit: string;
  contains(ancestor: string, descendant: string): boolean;
};

export type DeploymentLedger =
  /** `attempts` is set when only failed initial attempts exist: each one's start and final status time. */
  | { state: "uninitialized"; attempts?: AttemptWindow[] }
  | {
      state: "ready";
      deploymentId: number;
      gitCommit: string;
      pins: PinSummary;
      payload: DeploymentPayload;
      /** The failed release after this success that the release now running rolls forward over. */
      superseded?: SupersededRelease;
    }
  | {
      state: "unresolved";
      deploymentId: number;
      gitCommit: string;
      deploymentStatus: string;
      reason: string;
      lastSuccessful?: { deploymentId: number; gitCommit: string; pins: PinSummary };
      payload?: DeploymentPayload;
      /** Why the failed release could not be rolled forward over, when a release asked. */
      supersedeRefusal?: string;
    };

type Deployment = {
  id: number;
  sha: string;
  environment: string;
  payload: unknown;
  created_at: string;
};

export function readLedgerEnvironment(source = process.env): LedgerEnvironment {
  const token = source.GITHUB_TOKEN;
  const repository = source.GITHUB_REPOSITORY;
  if (!token?.trim()) throw new SafetyGateError("GITHUB_TOKEN is required for the production deploy ledger");
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new SafetyGateError("GITHUB_REPOSITORY must identify the current repository");
  return { token, repository };
}

/**
 * The production ledger. With `rollForward`, the single release that failed after the last success
 * is set aside when the release now running contains its commit: the ledger is then ready at the
 * last success, and that release deploys forward from it, re-applying everything the failed one
 * did. Anything else stays unresolved. Rollback paths read the ledger without it.
 */
export async function readDeploymentLedger(
  environment: LedgerEnvironment,
  fetcher: Fetcher = fetch,
  rollForward?: RollForward,
): Promise<DeploymentLedger> {
  const deployments = await listDeployments(environment, fetcher);
  deployments.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id);
  const ledger = await readLatestDeployment(deployments, environment, fetcher);
  if (!rollForward || ledger.state !== "unresolved" || !ledger.lastSuccessful) return ledger;
  const result = await supersedeFailedRelease(deployments, ledger.lastSuccessful, environment, fetcher, rollForward);
  if ("refusal" in result) return { ...ledger, supersedeRefusal: result.refusal };
  return { ...result.ready, superseded: result.superseded };
}

/** The ledger from the latest deployment; `deployments` is sorted newest first. */
async function readLatestDeployment(
  deployments: Deployment[],
  environment: LedgerEnvironment,
  fetcher: Fetcher,
): Promise<DeploymentLedger> {
  if (deployments.length === 0) return { state: "uninitialized" };
  const latest = deployments[0]!;
  if (latest.environment !== "production")
    throw new SafetyGateError("Latest GitHub deployment record is outside production; refusing to use it as a baseline");
  const commit = gitCommit(latest.sha, "latest deployment SHA");
  const statuses = await listStatuses(environment, latest.id, fetcher);
  const latestPayload = parseDeploymentPayload(latest.payload);
  if (latestPayload.gitCommit !== commit)
    throw new SafetyGateError("Latest production deployment payload does not match its SHA");
  if (statuses.length === 0)
    return {
      state: "unresolved",
      deploymentId: latest.id,
      gitCommit: commit,
      deploymentStatus: "missing",
      reason: "latest deployment has no status",
      lastSuccessful: await findPreviousSuccessfulDeployment(deployments.slice(1), environment, fetcher),
      payload: latestPayload,
    };
  const status = statuses[0]!;
  if (status.state !== "success") {
    const lastSuccessful = await findPreviousSuccessfulDeployment(deployments.slice(1), environment, fetcher);
    // Attempts that all ended before production ever succeeded leave no baseline to protect, so a retry
    // starts as an initial release and the initial-database check still runs. Pending or unfinished
    // attempts, and any failure after a success, stay unresolved.
    const earlier = !lastSuccessful && endedWithoutSuccess(statuses)
      ? await endedAttemptWindows(deployments.slice(1), environment, fetcher)
      : undefined;
    if (earlier) return { state: "uninitialized", attempts: [{ startedAt: latest.created_at, endedAt: status.created_at }, ...earlier] };
    return {
      state: "unresolved",
      deploymentId: latest.id,
      gitCommit: commit,
      deploymentStatus: status.state,
      reason: "latest production deployment did not finish successfully",
      lastSuccessful,
      payload: latestPayload,
    };
  }

  return { state: "ready", deploymentId: latest.id, gitCommit: commit, pins: latestPayload.pins, payload: latestPayload };
}

export function assertReportUsesLatestDeploy(report: ClassificationReport, ledger: DeploymentLedger): void {
  if (ledger.state === "uninitialized") return;
  if (ledger.state === "unresolved") {
    if (ledger.lastSuccessful) verifyReportBase(report, ledger.lastSuccessful);
    throw new SafetyGateError(`Latest production deployment is unresolved (${ledger.deploymentStatus}); reconcile it before another release` +
      (ledger.supersedeRefusal ? `. It was not superseded: ${ledger.supersedeRefusal}` : ""));
  }
  verifyReportBase(report, { gitCommit: ledger.gitCommit, pins: ledger.pins });
}

export function assertManualRollbackCandidate(report: ClassificationReport, ledger: DeploymentLedger): void {
  if (ledger.state === "uninitialized")
    throw new SafetyGateError("Manual rollback requires a recorded production release");
  if (ledger.state === "unresolved" && ledger.deploymentStatus !== "failure" && ledger.deploymentStatus !== "error")
    throw new SafetyGateError("Manual rollback requires the latest release attempt to be complete or failed");
  const payload = ledger.payload;
  if (!payload || payload.kind !== "release" || ledger.gitCommit !== report.candidate.gitCommit ||
      payload.candidateGitCommit !== report.candidate.gitCommit || payload.baseGitCommit !== report.base.gitCommit ||
      payload.reportDigest !== reportDigest(report))
    throw new SafetyGateError("Manual rollback report does not identify the latest production release");
  if (stableStringify(payload.basePins) !== stableStringify(summarizePins(report.base.pins)))
    throw new SafetyGateError("Manual rollback report pins do not match the recorded release baseline");
  if (ledger.state === "ready") {
    if (payload.gitCommit !== ledger.gitCommit || stableStringify(payload.pins) !== stableStringify(summarizePins(report.candidate.pins)))
      throw new SafetyGateError("Manual rollback report pins do not match the deployed release");
    if (payload.baseGitCommit === payload.candidateGitCommit)
      throw new SafetyGateError("Manual rollback has no prior successful production baseline");
    return;
  }
  if (!ledger.lastSuccessful) throw new SafetyGateError("Manual rollback has no prior successful production baseline");
  verifyReportBase(report, ledger.lastSuccessful);
}

export async function beginReleaseDeployment(
  report: ClassificationReport,
  environment: LedgerEnvironment,
  fetcher: Fetcher = fetch,
  backup?: RecordedBackup,
  rollForward?: RollForward,
): Promise<number> {
  const ledger = await readDeploymentLedger(environment, fetcher, rollForward);
  assertReportUsesLatestDeploy(report, ledger);
  if (ledger.state === "unresolved") throw new SafetyGateError("Cannot begin while another production deployment is unresolved");
  if (report.databaseChanged && !backup)
    throw new SafetyGateError("Database-changing release requires the protected backup before deployment begins");
  if (backup) assertBackupMatchesReport(backup, report);
  const payload = makePayload(report, report.candidate.gitCommit, report.candidate.pins, "release", backup);
  return createDeployment(environment, payload, fetcher);
}

export async function beginRollbackDeployment(
  report: ClassificationReport,
  environment: LedgerEnvironment,
  fetcher: Fetcher = fetch,
  expectedDeploymentId?: number,
): Promise<number> {
  const ledger = await readDeploymentLedger(environment, fetcher);
  if (ledger.state === "uninitialized") throw new SafetyGateError("Cannot roll back before a production deployment exists");
  if (expectedDeploymentId !== undefined && ledger.deploymentId !== expectedDeploymentId)
    throw new SafetyGateError("Production deployment changed after the rollback plan was prepared");
  assertManualRollbackCandidate(report, ledger);

  const backup = report.databaseChanged ? releaseBackup(ledger) : undefined;
  const rollbackPayload = makePayload(report, report.base.gitCommit, report.base.pins, "rollback", backup);
  rollbackPayload.rollbackOf = report.candidate.gitCommit;
  return createDeployment(environment, rollbackPayload, fetcher);
}

export async function finishDeployment(
  deploymentId: number,
  state: "success" | "failure",
  environment: LedgerEnvironment,
  fetcher: Fetcher = fetch,
): Promise<void> {
  if (!Number.isInteger(deploymentId) || deploymentId < 1)
    throw new SafetyGateError("Deployment id is invalid");
  const url = `${apiOrigin}/repos/${repositoryPath(environment.repository)}/deployments/${deploymentId}`;
  const reply = await requestJson(fetcher, "GitHub", url, {
    method: "GET",
    headers: headers(environment.token),
  });
  const deployment = record(reply.body, "GitHub deployment");
  if (deployment.environment !== "production") throw new SafetyGateError("Deployment id does not refer to production");
  const payload = parseDeploymentPayload(deployment.payload);
  if (deployment.sha !== payload.gitCommit) throw new SafetyGateError("Deployment SHA does not match its metadata");

  const statusUrl = `${url}/statuses`;
  await requestJson(fetcher, "GitHub", statusUrl, {
    method: "POST",
    headers: headers(environment.token),
    body: JSON.stringify({
      state,
      description: state === "success" ? "Production deployment verified" : "Production deployment did not complete",
    }),
  }, [201]);
}

export function deploymentPayloadFor(
  report: ClassificationReport,
  kind: "release" | "rollback" = "release",
  backup?: RecordedBackup,
): DeploymentPayload {
  const gitCommit = kind === "release" ? report.candidate.gitCommit : report.base.gitCommit;
  const pins = kind === "release" ? report.candidate.pins : report.base.pins;
  return makePayload(report, gitCommit, pins, kind, backup);
}

/** The protected backup the latest production release recorded, verified when its payload was parsed. */
export function releaseBackup(ledger: DeploymentLedger): RecordedBackup {
  const payload = ledger.state === "uninitialized" ? undefined : ledger.payload;
  if (!payload?.backupName || !payload.backupMetadata)
    throw new SafetyGateError("Database rollback is missing its protected backup reference");
  return { name: payload.backupName, metadata: payload.backupMetadata };
}

async function createDeployment(
  environment: LedgerEnvironment,
  payload: DeploymentPayload,
  fetcher: Fetcher,
): Promise<number> {
  const url = `${apiOrigin}/repos/${repositoryPath(environment.repository)}/deployments`;
  const reply = await requestJson(fetcher, "GitHub", url, {
    method: "POST",
    headers: headers(environment.token),
    body: JSON.stringify({
      ref: payload.gitCommit,
      task: "deploy",
      auto_merge: false,
      required_contexts: [],
      environment: "production",
      production_environment: true,
      description: payload.kind === "release" ? "Basalt production release" : "Basalt production rollback",
      payload,
    }),
  }, [201]);
  const deployment = record(reply.body, "GitHub deployment");
  const id = deployment.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || deployment.sha !== payload.gitCommit || deployment.environment !== "production")
    throw new SafetyGateError("GitHub did not create the expected production deployment record");
  if (stableStringify(parseDeploymentPayload(deployment.payload)) !== stableStringify(payload))
    throw new SafetyGateError("GitHub production deployment metadata did not round-trip");

  await requestJson(fetcher, "GitHub", `${url}/${id}/statuses`, {
    method: "POST",
    headers: headers(environment.token),
    body: JSON.stringify({ state: "in_progress", description: "Production safety gates passed" }),
  }, [201]);
  writeActionOutput("deployment_id", String(id));
  return id;
}

function makePayload(
  report: ClassificationReport,
  gitCommit: string,
  pins: ClassificationReport["candidate"]["pins"],
  kind: "release" | "rollback",
  backup?: RecordedBackup,
): DeploymentPayload {
  const payload: DeploymentPayload = {
    system: systemName,
    schemaVersion: 1,
    kind,
    gitCommit,
    pins: summarizePins(pins),
    basePins: summarizePins(report.base.pins),
    baseGitCommit: report.base.gitCommit,
    candidateGitCommit: report.candidate.gitCommit,
    databaseChanged: report.databaseChanged,
    workflowChanged: report.workflowChanged,
    reportDigest: reportDigest(report),
  };
  if (backup) {
    payload.backupName = backup.name;
    payload.backupMetadata = backup.metadata;
  }
  return payload;
}

function parseDeploymentPayload(value: unknown): DeploymentPayload {
  const payload = record(value, "GitHub deployment payload");
  if (payload.system !== systemName || payload.schemaVersion !== 1 || (payload.kind !== "release" && payload.kind !== "rollback"))
    throw new SafetyGateError("GitHub deployment is missing Basalt release ledger metadata");
  if (typeof payload.databaseChanged !== "boolean" || typeof payload.workflowChanged !== "boolean")
    throw new SafetyGateError("GitHub deployment ledger has invalid classification flags");
  const parsed: DeploymentPayload = {
    system: systemName,
    schemaVersion: 1,
    kind: payload.kind,
    gitCommit: gitCommit(payload.gitCommit, "deployment payload gitCommit"),
    pins: parsePinSummary(payload.pins),
    basePins: parsePinSummary(payload.basePins, "deployment baseline pins"),
    baseGitCommit: gitCommit(payload.baseGitCommit, "deployment payload baseGitCommit"),
    candidateGitCommit: gitCommit(payload.candidateGitCommit, "deployment payload candidateGitCommit"),
    databaseChanged: payload.databaseChanged,
    workflowChanged: payload.workflowChanged,
    reportDigest: hexDigest(payload.reportDigest, "deployment report digest"),
  };
  if (payload.backupName !== undefined) {
    if (typeof payload.backupName !== "string") throw new SafetyGateError("Deployment backup name is invalid");
    parsed.backupName = payload.backupName;
    parsed.backupMetadata = verifyBackupMetadata(payload.backupName, payload.backupMetadata);
    assertBackupMatchesPayload(parsed.backupMetadata, parsed);
  } else if (payload.backupMetadata !== undefined) {
    throw new SafetyGateError("Deployment backup metadata has no backup name");
  } else if (parsed.databaseChanged && parsed.kind === "release") {
    throw new SafetyGateError("Database-changing deployment ledger is missing its rollback backup name");
  }
  if (payload.rollbackOf !== undefined)
    parsed.rollbackOf = gitCommit(payload.rollbackOf, "deployment rollbackOf");
  return parsed;
}

function assertBackupMatchesPayload(metadata: BackupMetadata, payload: DeploymentPayload): void {
  if (metadata.base.gitCommit !== payload.baseGitCommit ||
      metadata.candidate.gitCommit !== payload.candidateGitCommit ||
      stableStringify(metadata.base.pins) !== stableStringify(payload.basePins) ||
      (payload.kind === "release" && stableStringify(metadata.candidate.pins) !== stableStringify(payload.pins)))
    throw new SafetyGateError("Deployment backup metadata does not match its release transition");
}

function assertBackupMatchesReport(backup: RecordedBackup, report: ClassificationReport): void {
  if (!backupMatchesReport(verifyBackupMetadata(backup.name, backup.metadata), report))
    throw new SafetyGateError("PlanetScale backup metadata does not match the release classification");
}

async function listDeployments(environment: LedgerEnvironment, fetcher: Fetcher): Promise<Deployment[]> {
  const all: Deployment[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= maximumPages; page++) {
    const query = new URLSearchParams({ environment: "production", per_page: String(pageSize), page: String(page) });
    const url = `${apiOrigin}/repos/${repositoryPath(environment.repository)}/deployments?${query}`;
    const reply = await requestJson(fetcher, "GitHub", url, { method: "GET", headers: headers(environment.token) });
    if (!Array.isArray(reply.body)) throw new SafetyGateError("GitHub deployment list omitted results");
    for (const item of reply.body) {
      const deployment = record(item, "GitHub deployment list item");
      const id = deployment.id;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || seen.has(id))
        throw new SafetyGateError("GitHub deployment list contains an invalid or duplicate id");
      const createdAt = stringField(deployment.created_at, "GitHub deployment created_at");
      if (!Number.isFinite(Date.parse(createdAt))) throw new SafetyGateError("GitHub deployment timestamp is invalid");
      seen.add(id);
      all.push({
        id,
        sha: gitCommit(deployment.sha, "GitHub deployment SHA"),
        environment: stringField(deployment.environment, "GitHub deployment environment"),
        payload: deployment.payload,
        created_at: createdAt,
      });
    }
    if (reply.body.length < pageSize) return all;
  }
  throw new SafetyGateError("GitHub deployment history exceeded the pagination limit");
}

/** A deployment's statuses, newest first. */
async function listStatuses(
  environment: LedgerEnvironment,
  deploymentId: number,
  fetcher: Fetcher,
): Promise<Array<{ id: number; state: string; created_at: string }>> {
  const all: Array<{ id: number; state: string; created_at: string }> = [];
  const seen = new Set<number>();
  for (let page = 1; page <= maximumPages; page++) {
    const query = new URLSearchParams({ per_page: String(pageSize), page: String(page) });
    const url = `${apiOrigin}/repos/${repositoryPath(environment.repository)}/deployments/${deploymentId}/statuses?${query}`;
    const reply = await requestJson(fetcher, "GitHub", url, { method: "GET", headers: headers(environment.token) });
    if (!Array.isArray(reply.body)) throw new SafetyGateError("GitHub deployment status list omitted results");
    for (const item of reply.body) {
      const status = record(item, "GitHub deployment status");
      const id = status.id;
      const createdAt = stringField(status.created_at, "GitHub deployment status timestamp");
      if (typeof id !== "number" || !Number.isInteger(id) || seen.has(id) || !Number.isFinite(Date.parse(createdAt)))
        throw new SafetyGateError("GitHub deployment status list is inconsistent");
      seen.add(id);
      all.push({ id, state: stringField(status.state, "GitHub deployment status state"), created_at: createdAt });
    }
    if (reply.body.length < pageSize)
      return all.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id);
  }
  throw new SafetyGateError("GitHub deployment status history exceeded the pagination limit");
}

/** Only the runner's own terminal failure states count; `inactive` is set by hand and may retire a success. */
const endedAttempt = new Set(["failure", "error"]);

function endedWithoutSuccess(statuses: Array<{ state: string }>): boolean {
  return endedAttempt.has(statuses[0]?.state ?? "missing") && !statuses.some(({ state }) => state === "success");
}

/** Each attempt's window, or undefined when any attempt is unfinished, succeeded or outside production. */
async function endedAttemptWindows(
  deployments: Deployment[],
  environment: LedgerEnvironment,
  fetcher: Fetcher,
): Promise<AttemptWindow[] | undefined> {
  const windows: AttemptWindow[] = [];
  for (const deployment of deployments) {
    if (deployment.environment !== "production") return undefined;
    const statuses = await listStatuses(environment, deployment.id, fetcher);
    if (!endedWithoutSuccess(statuses)) return undefined;
    windows.push({ startedAt: deployment.created_at, endedAt: statuses[0]!.created_at });
  }
  return windows;
}

/**
 * Sets aside the one failed release since the last success when the release now running contains
 * it, or says why it can't. Exactly one record may follow that success: a release whose latest
 * status is `failure` or `error`, that never reported success, and whose recorded base is that
 * success with the same pins. Its commit must be the commit being released or one of its
 * ancestors. A second record since the success, which is the superseding release failing too, a
 * pending, in-progress, status-less or inactive record, a rollback record, or a commit git can't
 * show is contained keeps the ledger unresolved.
 */
async function supersedeFailedRelease(
  deployments: Deployment[],
  lastSuccessful: { deploymentId: number; gitCommit: string; pins: PinSummary },
  environment: LedgerEnvironment,
  fetcher: Fetcher,
  rollForward: RollForward,
): Promise<{ ready: Extract<DeploymentLedger, { state: "ready" }>; superseded: SupersededRelease } | { refusal: string }> {
  const index = deployments.findIndex(({ id }) => id === lastSuccessful.deploymentId);
  if (index < 0) return { refusal: "the last successful deployment is missing from the ledger" };
  if (index !== 1)
    return { refusal: `${index} deployment records follow the last success; only a single failed release is rolled forward, so a person decides` };
  const failed = deployments[0]!;
  const refuse = (why: string) => ({ refusal: `deployment ${failed.id} ${why}` });
  if (failed.environment !== "production") return refuse("is outside production");
  const statuses = await listStatuses(environment, failed.id, fetcher);
  const status = statuses[0]?.state ?? "missing";
  if (!endedWithoutSuccess(statuses)) return refuse(`is ${status}, not a failed attempt that never succeeded`);
  let payload: DeploymentPayload;
  try {
    payload = parseDeploymentPayload(failed.payload);
  } catch {
    return refuse("has unreadable ledger metadata");
  }
  if (payload.kind !== "release") return refuse("is a rollback, not a release");
  if (payload.gitCommit !== failed.sha || payload.candidateGitCommit !== failed.sha)
    return refuse("metadata does not match its SHA");
  if (payload.baseGitCommit !== lastSuccessful.gitCommit ||
      stableStringify(payload.basePins) !== stableStringify(lastSuccessful.pins))
    return refuse("was not based on the last successful deployment");
  let contained: boolean;
  try {
    contained = rollForward.contains(failed.sha, rollForward.candidateGitCommit);
  } catch (error) {
    return refuse(`could not be checked against ${rollForward.candidateGitCommit}: ${error instanceof Error ? error.message.split("\n")[0] : "git failed"}`);
  }
  if (!contained) return refuse(`is not contained in ${rollForward.candidateGitCommit}, so that release would not re-apply it`);
  const success = deployments[1]!;
  return {
    ready: {
      state: "ready",
      deploymentId: success.id,
      gitCommit: lastSuccessful.gitCommit,
      pins: lastSuccessful.pins,
      payload: parseDeploymentPayload(success.payload),
    },
    superseded: { deploymentId: failed.id, gitCommit: failed.sha, deploymentStatus: status },
  };
}

async function findPreviousSuccessfulDeployment(
  deployments: Deployment[],
  environment: LedgerEnvironment,
  fetcher: Fetcher,
): Promise<{ deploymentId: number; gitCommit: string; pins: PinSummary } | undefined> {
  for (const deployment of deployments) {
    if (deployment.environment !== "production") continue;
    const statuses = await listStatuses(environment, deployment.id, fetcher);
    if (statuses[0]?.state !== "success") continue;
    const payload = parseDeploymentPayload(deployment.payload);
    const sha = gitCommit(deployment.sha, "successful deployment SHA");
    if (payload.gitCommit !== sha) throw new SafetyGateError("Successful production deployment metadata does not match its SHA");
    return { deploymentId: deployment.id, gitCommit: sha, pins: payload.pins };
  }
  return undefined;
}

function headers(token: string): Record<string, string> {
  return withBearer(token, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  });
}

function repositoryPath(repository: string): string {
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new SafetyGateError("GITHUB_REPOSITORY is invalid");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function gitCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value))
    throw new SafetyGateError(`${label} is invalid`);
  return value.toLowerCase();
}

function hexDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value))
    throw new SafetyGateError(`${label} is invalid`);
  return value.toLowerCase();
}

function writeActionOutput(name: string, value: string): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  if (/[\r\n]/.test(value)) throw new SafetyGateError("GitHub action output contains a line break");
  appendFileSync(path, `${name}=${value}\n`, { encoding: "utf8", mode: 0o600 });
}
