import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GitHubApi } from "./github.ts";
import { classifyRefs } from "./classify.ts";
import { git, pushReleaseBranch } from "./git.ts";
import { manualReleaseLabel, reconcileMetadata, managedRiskLabelsInBody, releaseUpdateLabel, updateSafetySection } from "./metadata.ts";
import { RELEASE_MERGE_POLICY, validateChangedFiles } from "../release-merge/policy.ts";
import { sameJson, validateReleaseReceipt } from "../release-merge/metadata.ts";
import type { UpdatePlan, UpdateSource } from "./update.ts";
import type { ClassificationReport } from "./types.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ownerBot = "github-actions[bot]";
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
const labelDefinitions = [
  { name: releaseUpdateLabel, color: "0e8a16", description: "Release update created and maintained by the scheduled updater" },
  { name: manualReleaseLabel, color: "f9d0c4", description: "Release needs a maintainer decision" },
  { name: "database-change", color: "b60205", description: "Release may change persisted database state" },
  { name: "workflow-identity-change", color: "5319e7", description: "Release may change durable Workflow identity" },
];

export type ReleasePullRequest = {
  number: number;
  state: "open" | "closed";
  merged_at?: string | null;
  title: string;
  body: string | null;
  user?: { login?: string; type?: string } | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } | null };
  labels: Array<{ name: string }>;
};

export type ReconcileResult = {
  outcome: "created" | "updated" | "closed" | "unchanged";
  source: UpdateSource;
  releaseKey: string;
  branch: string;
  pullRequest?: number;
  head?: string;
  preparationFailed: boolean;
  riskLabels: string[];
};

export async function reconcileReleasePullRequest(
  repositoryRoot: string,
  repository: string,
  source: UpdateSource,
  plan: UpdatePlan,
  token: string,
  preparationFailure?: string,
  api: Pick<GitHubApi, "get" | "request" | "compare" | "compareTrees"> = new GitHubApi(token),
): Promise<ReconcileResult> {
  if (!token) throw new Error("RELEASE_UPDATE_TOKEN is required to reconcile release pull requests");
  const mainSha = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  const branch = `${RELEASE_MERGE_POLICY.updaterBranchPrefix}${plan.releaseKey}`;
  const existing = await findReleasePullRequest(api, repository, branch);
  const closed = existing.find((pull) => pull.state !== "open");
  const open = existing.filter((pull) => pull.state === "open");
  if (open.length > 1) throw new Error("More than one open pull request uses the release branch");
  if (!open.length && closed?.merged_at) return result("unchanged", source, plan.releaseKey, branch, plan, preparationFailure);
  if (!open.length && closed) return result("unchanged", source, plan.releaseKey, branch, plan, preparationFailure);

  const pull = open[0];
  let previousHead: string | undefined;
  if (pull) {
    await validateExistingPullRequest(api, repository, pull, source, plan, branch, mainSha);
    previousHead = pull.head.sha;
  } else {
    previousHead = await getBranchSha(api, repository, branch);
    if (previousHead) await validateOrphanBranch(api, repository, branch, previousHead, source, plan, mainSha);
  }

  const stagedPaths = stagePaths(repositoryRoot, source);
  if (stagedPaths.length === 0) {
    if (!pull) return result("unchanged", source, plan.releaseKey, branch, plan, preparationFailure);
    const report = await classifyRefs(repositoryRoot, mainSha, pull.head.sha, api);
    await closeRedundantPullRequest(api, repository, pull, source, plan, report);
    return result("closed", source, plan.releaseKey, branch, plan, preparationFailure, pull.number, pull.head.sha);
  }

  if (!stagedPaths.every((path) => isReleasePath(path, source)))
    throw new Error("Release branch contains a change outside its updater allowlist");
  for (const path of patchPaths(stagedPaths)) {
    const status = git(repositoryRoot, ["diff", "--cached", "--name-status", "--", path]).trim().split("\t")[0];
    if (status !== "D") throw new Error("Release updater may only remove carried patch files");
  }

  const headSha = commitCandidate(repositoryRoot, plan.releaseKey);
  const report = await classifyRefs(repositoryRoot, mainSha, headSha, api);
  if (pull) await putTemporaryManualHold(api, repository, pull, report, plan, preparationFailure);
  pushReleaseBranch(repositoryRoot, branch, previousHead, token);

  const afterPush = pull
    ? await api.get<ReleasePullRequest>(`repos/${repoPath(repository)}/pulls/${pull.number}`)
    : undefined;
  if (afterPush && afterPush.head.sha !== headSha)
    throw new Error("Release pull request head changed during branch reconciliation");

  const title = `${titleFor(source)} ${plan.releaseKey}`;
  if (afterPush) {
    await updateExistingPullRequest(api, repository, afterPush, report, plan, title, preparationFailure);
  } else {
    const body = makeBody(plan.releaseKey, report, preparationFailure);
    const created = await api.request<ReleasePullRequest>("POST", `repos/${repoPath(repository)}/pulls`, {
      title,
      head: branch,
      base: "main",
      body,
      draft: false,
    });
    await updateExistingPullRequest(api, repository, created, report, plan, title, preparationFailure);
  }

  const latest = pull ? await api.get<ReleasePullRequest>(`repos/${repoPath(repository)}/pulls/${pull.number}`)
    : await findReleasePullRequest(api, repository, branch).then((items) => items.find((item) => item.state === "open"));
  if (!latest || latest.head.sha !== headSha) throw new Error("GitHub did not confirm the exact release branch head");
  return result(pull ? "updated" : "created", source, plan.releaseKey, branch, plan, preparationFailure, latest.number, headSha, requiredLabels(report));
}

async function validateExistingPullRequest(
  api: Pick<GitHubApi, "get" | "compare">,
  repository: string,
  pull: ReleasePullRequest,
  source: UpdateSource,
  plan: UpdatePlan,
  branch: string,
  mainSha: string,
): Promise<void> {
  if (pull.head.repo?.full_name !== repository || pull.base.repo?.full_name !== repository || pull.base.ref !== "main" || pull.head.ref !== branch)
    throw new Error("Existing release pull request does not match its updater branch");
  if (!pull.labels.some((label) => label.name === releaseUpdateLabel))
    throw new Error("Existing release pull request is missing updater provenance label");
  if (!hasProvenanceMarker(pull.body ?? "", plan.releaseKey))
    throw new Error("Existing release pull request is missing its updater provenance marker");
  const candidate = await validateBranchSnapshot(api, repository, pull.head.sha, source, plan);
  if (candidate.releaseKey !== plan.releaseKey || !candidate.allowed)
    throw new Error(`Existing release pull request failed provenance validation: ${candidate.reasons.join("; ")}`);
  const ancestry = await api.get<{ merge_base_commit?: { sha?: string } }>(
    `repos/${repoPath(repository)}/compare/${encodeURIComponent(mainSha)}...${encodeURIComponent(pull.head.sha)}`,
  );
  if (!ancestry.merge_base_commit?.sha) throw new Error("Existing release pull request has no verifiable base ancestry");
}

async function validateOrphanBranch(
  api: Pick<GitHubApi, "get" | "compare">,
  repository: string,
  branch: string,
  head: string,
  source: UpdateSource,
  plan: UpdatePlan,
  _mainSha: string,
): Promise<void> {
  const result = await validateBranchSnapshot(api, repository, head, source, plan);
  if (!result.allowed || result.releaseKey !== plan.releaseKey || branch !== `${RELEASE_MERGE_POLICY.updaterBranchPrefix}${result.releaseKey}`)
    throw new Error("An existing release branch without an open pull request failed receipt provenance checks");
}

async function validateBranchSnapshot(
  api: Pick<GitHubApi, "get" | "compare">,
  repository: string,
  head: string,
  source: UpdateSource,
  plan: UpdatePlan,
): Promise<ReturnType<typeof validateChangedFiles>> {
  const headCommit = await api.get<{ parents?: Array<{ sha: string }> }>(`repos/${repoPath(repository)}/commits/${encodeURIComponent(head)}`);
  const base = headCommit.parents?.[0]?.sha;
  if (!base) throw new Error("Existing release branch has no recorded base commit");
  const comparison = await api.compare(repository, base, head);
  if (!comparison.complete) throw new Error("Existing release branch file comparison is incomplete");
  const files = comparison.files.map((file) => ({
    filename: file.filename,
    status: file.status ?? "unknown",
    additions: file.additions ?? -1,
    deletions: file.deletions ?? -1,
    changes: file.changes ?? -1,
  }));
  const contents: Record<string, { base?: string; candidate?: string }> = {};
  const contentPaths = new Set([
    "upstream.json", "containers/pool/releases.json", "src/pool/providers.json", "scripts/releases/patches.json",
    `scripts/releases/receipts/${source}.json`,
  ]);
  for (const file of files) if (contentPaths.has(file.filename)) {
    const [before, after] = await Promise.all([
      readGitHubFile(api, repository, file.filename, base),
      readGitHubFile(api, repository, file.filename, head),
    ]);
    contents[file.filename] = { ...(before === undefined ? {} : { base: before }), ...(after === undefined ? {} : { candidate: after }) };
  }
  const policy = validateChangedFiles(files, contents);
  if (policy.releaseKey !== plan.releaseKey) policy.reasons.push("existing branch release key does not match this candidate");
  const receiptText = contents[`scripts/releases/receipts/${source}.json`]?.candidate;
  if (!receiptText) policy.reasons.push("existing branch receipt is missing");
  else {
    const parsed = (await import("../release-merge/metadata.ts")).validateReleaseReceipt(receiptText, source);
    if (!parsed.ok) policy.reasons.push(`existing branch receipt is invalid: ${parsed.reason}`);
    else if (!sameJson(parsed.receipt.candidatePins[source], plan.candidatePins[source]))
      policy.reasons.push("existing branch receipt does not target this released source pin");
  }
  policy.allowed = policy.reasons.length === 0;
  return policy;
}

async function readGitHubFile(api: Pick<GitHubApi, "get">, repository: string, path: string, ref: string): Promise<string | undefined> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  try {
    const file = await api.get<{ type: string; encoding: string; content: string }>(`repos/${repoPath(repository)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
    if (file.type !== "file" || file.encoding !== "base64") throw new Error("GitHub returned unsupported release metadata");
    return Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return undefined;
    throw error;
  }
}

async function putTemporaryManualHold(
  api: Pick<GitHubApi, "request">,
  repository: string,
  pull: ReleasePullRequest,
  report: ClassificationReport,
  plan: UpdatePlan,
  preparationFailure?: string,
): Promise<void> {
  await ensureLabels(api, repository, [manualReleaseLabel]);
  const labels = pull.labels.map(({ name }) => name);
  if (!labels.includes(manualReleaseLabel))
    await api.request("POST", `repos/${repoPath(repository)}/issues/${pull.number}/labels`, { labels: [manualReleaseLabel] });
  const managed = new Set(managedRiskLabelsInBody(pull.body ?? ""));
  managed.add(manualReleaseLabel);
  const body = setProvenanceMarker(pull.body ?? "", plan.releaseKey);
  await api.request("PATCH", `repos/${repoPath(repository)}/pulls/${pull.number}`, {
    body: withPreparationSection(updateSafetySection(body, report, [...managed], "machine"), preparationFailure),
  });
}

async function updateExistingPullRequest(
  api: Pick<GitHubApi, "get" | "request">,
  repository: string,
  pull: ReleasePullRequest,
  report: ClassificationReport,
  plan: UpdatePlan,
  title: string,
  preparationFailure?: string,
): Promise<void> {
  const current = await api.get<ReleasePullRequest>(`repos/${repoPath(repository)}/pulls/${pull.number}`);
  const currentLabels = current.labels.map(({ name }) => name);
  const managed = new Set(managedRiskLabelsInBody(current.body ?? ""));
  const holdOwnership = currentLabels.includes(manualReleaseLabel)
    ? managed.has(manualReleaseLabel) ? "machine" : "human"
    : "none";
  const metadata = reconcileMetadata({
    currentLabels,
    existingBody: setProvenanceMarker(current.body ?? "", plan.releaseKey),
    report,
    manualHoldOwnership: holdOwnership,
  });
  const body = withPreparationSection(metadata.body, preparationFailure);
  await ensureLabels(api, repository, [releaseUpdateLabel, ...metadata.labels]);
  for (const label of metadata.added) await api.request("POST", `repos/${repoPath(repository)}/issues/${pull.number}/labels`, { labels: [label] });
  await api.request("PATCH", `repos/${repoPath(repository)}/pulls/${pull.number}`, { title, body });
  for (const label of metadata.removed) await api.request("DELETE", `repos/${repoPath(repository)}/issues/${pull.number}/labels/${encodeURIComponent(label)}`);
}

async function closeRedundantPullRequest(
  api: Pick<GitHubApi, "request">,
  repository: string,
  pull: ReleasePullRequest,
  source: UpdateSource,
  plan: UpdatePlan,
  report: ClassificationReport,
): Promise<void> {
  const body = withPreparationSection(reconcileMetadata({
    currentLabels: pull.labels.map(({ name }) => name),
    existingBody: pull.body ?? "",
    report,
    manualHoldOwnership: pull.labels.some(({ name }) => name === manualReleaseLabel)
      ? managedRiskLabelsInBody(pull.body ?? "").includes(manualReleaseLabel) ? "machine" : "human"
      : "none",
  }).body, undefined);
  await api.request("PATCH", `repos/${repoPath(repository)}/pulls/${pull.number}`, {
    body,
    state: "closed",
  });
}

async function ensureLabels(api: Pick<GitHubApi, "get" | "request">, repository: string, names: string[]): Promise<void> {
  for (const label of labelDefinitions.filter(({ name }) => names.includes(name))) {
    try {
      await api.get(`repos/${repoPath(repository)}/labels/${encodeURIComponent(label.name)}`);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "status" in error && error.status === 404)) throw error;
      await api.request("POST", `repos/${repoPath(repository)}/labels`, label);
    }
  }
}

async function findReleasePullRequest(
  api: Pick<GitHubApi, "get">,
  repository: string,
  branch: string,
): Promise<ReleasePullRequest[]> {
  const owner = repository.split("/")[0]!;
  const head = encodeURIComponent(`${owner}:${branch}`);
  const result = await api.get<ReleasePullRequest[]>(`repos/${repoPath(repository)}/pulls?state=all&head=${head}&base=main&per_page=100`);
  if (!Array.isArray(result)) throw new Error("GitHub returned an invalid release pull request list");
  return result.filter((pull) => pull.head.ref === branch && pull.base.ref === "main");
}

async function getBranchSha(api: Pick<GitHubApi, "get">, repository: string, branch: string): Promise<string | undefined> {
  try {
    const commit = await api.get<{ sha: string }>(`repos/${repoPath(repository)}/commits/${encodeURIComponent(branch)}`);
    return commit.sha;
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return undefined;
    throw error;
  }
}

function stagePaths(root: string, source: UpdateSource): string[] {
  const paths = [
    ...git(root, ["diff", "--name-only"]).trim().split("\n").filter(Boolean),
    ...git(root, ["ls-files", "--others", "--exclude-standard"]).trim().split("\n").filter(Boolean),
  ];
  if (!paths.length) return [];
  for (const path of paths) if (!isReleasePath(path, source)) throw new Error(`Release candidate changed a path outside its updater allowlist: ${path}`);
  git(root, ["add", "-A", "--", ...new Set(paths)]);
  const statuses = git(root, ["diff", "--cached", "--name-status"]).trim().split("\n").filter(Boolean).map((row) => row.split("\t"));
  for (const [status, ...names] of statuses) {
    const filename = names.at(-1)!;
    if (filename.startsWith("patches/") && status !== "D") throw new Error("Carried patches may only be removed by a release update");
    if (status === "R" || status === "C") throw new Error("Release updater does not accept file renames");
  }
  return statuses.map((row) => row.at(-1)!).sort();
}

function commitCandidate(root: string, releaseKey: string): string {
  git(root, [
    "-c", `user.name=${ownerBot}`,
    "-c", `user.email=${botEmail}`,
    "commit", "--quiet", "-m", `Update ${releaseKey}`,
  ]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function isReleasePath(path: string, source: UpdateSource): boolean {
  return path === "upstream.json" || path === "containers/pool/releases.json" || path === "src/pool/providers.json" ||
    path === "scripts/releases/patches.json" || path === `scripts/releases/receipts/${source}.json` ||
    path === RELEASE_MERGE_POLICY.generatedArchitecturePath || /^patches\/[A-Za-z0-9][A-Za-z0-9._-]*\.patch$/.test(path);
}

function patchPaths(paths: string[]): string[] { return paths.filter((path) => path.startsWith("patches/") && path.endsWith(".patch")); }
function repoPath(repository: string): string { return repository.split("/").map(encodeURIComponent).join("/"); }
function hasProvenanceMarker(body: string, releaseKey: string): boolean { return body.includes(`<!-- basalt-release-update:${releaseKey} -->`); }
function setProvenanceMarker(body: string, releaseKey: string): string {
  const markers = [...body.matchAll(/<!-- basalt-release-update:[A-Za-z0-9._-]+ -->/g)];
  if (markers.length > 1 || markers.length === 1 && markers[0]![0] !== `<!-- basalt-release-update:${releaseKey} -->`)
    throw new Error("Existing release PR provenance marker does not match its release branch");
  return markers.length ? body : `<!-- basalt-release-update:${releaseKey} -->\n\n${body}`;
}
function withPreparationSection(body: string, failure?: string): string {
  const start = "<!-- basalt-release-preparation:start -->";
  const end = "<!-- basalt-release-preparation:end -->";
  const startCount = body.split(start).length - 1;
  const endCount = body.split(end).length - 1;
  if (startCount !== endCount || startCount > 1) throw new Error("Release preparation section markers are invalid");
  const section = failure
    ? `${start}\n### Candidate preparation\n${failure}\nCheck must pass before merge.\n${end}`
    : "";
  if (!startCount) return `${body.trimEnd()}${section ? `\n\n${section}\n` : "\n"}`;
  const offset = body.indexOf(start);
  const endOffset = body.indexOf(end) + end.length;
  return `${body.slice(0, offset)}${section}${body.slice(endOffset)}`;
}
function makeBody(releaseKey: string, report: ClassificationReport, failure?: string): string {
  const provenance = `<!-- basalt-release-update:${releaseKey} -->\n\nAutomated pinned upstream update.`;
  const metadata = reconcileMetadata({ currentLabels: [], existingBody: provenance, report, manualHoldOwnership: "none" });
  return withPreparationSection(metadata.body, failure);
}
function requiredLabels(report: ClassificationReport): string[] {
  return [releaseUpdateLabel, ...(report.databaseChanged ? ["database-change"] : []), ...(report.workflowChanged ? ["workflow-identity-change"] : []), ...(report.databaseChanged || report.workflowChanged ? [manualReleaseLabel] : [])];
}
function titleFor(source: UpdateSource): string { return `Update ${source} release`; }
function result(outcome: ReconcileResult["outcome"], source: UpdateSource, releaseKey: string, branch: string, plan: UpdatePlan, failure?: string, pullRequest?: number, head?: string, riskLabels: string[] = []): ReconcileResult {
  return { outcome, source, releaseKey, branch, preparationFailed: failure !== undefined, riskLabels, ...(pullRequest === undefined ? {} : { pullRequest }), ...(head ? { head } : {}) };
}
