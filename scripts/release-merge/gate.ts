import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateReleaseCandidate, type CandidateValidation } from "./candidate.ts";
import { RELEASE_CLASSIFICATION_LABELS, validateReleaseClassification } from "./classification.ts";
import { GitHubApi, type MergeGateApi, type Review, type WorkflowRun } from "./github.ts";
import {
  RELEASE_MERGE_POLICY,
  validatePreviewReceipt,
  validatePullRequestIdentity,
  type PullRequestSnapshot,
} from "./policy.ts";

export type WorkflowRunTrigger = {
  runId: number;
  workflowName: string;
  event: string;
  conclusion: string | null;
  headSha: string;
  headBranch: string;
  repositoryFullName: string;
  headRepositoryFullName: string | null;
  pullRequests: Array<{
    number: number;
    head: { sha: string; ref: string; repositoryFullName: string | null };
    base: { ref: string; sha: string; repositoryFullName: string | null };
  }>;
};

export type GateResult = { status: "merged" | "skipped"; reason: string; pullRequest?: number; headSha?: string };

export type ReleaseProofResult = { allowed: true; proofs: { ci: WorkflowRun; preview: WorkflowRun } } | { allowed: false; reason: string };

export async function runReleaseMergeGate(
  api: MergeGateApi,
  repository: string,
  trigger: WorkflowRunTrigger,
): Promise<GateResult> {
  const triggerProblem = validateTrigger(trigger, repository);
  if (triggerProblem) return skipped(triggerProblem);
  const triggerPrNumber = trigger.pullRequests[0]!.number;

  const initial = await validateReleaseCandidate(api, repository, triggerPrNumber, trigger.headSha);
  if (!initial.allowed) return skipped(initial.reasons.join("; "), triggerPrNumber, initial.headSha);
  const rawClassification = await api.classifyCandidate(repository, triggerPrNumber, initial.currentMainSha!, initial.headSha!);
  const classification = validateReleaseClassification(rawClassification, { base: initial.currentMainSha!, candidate: initial.headSha! });
  if (!classification.decision) return skipped(classification.reasons.join("; "), triggerPrNumber, initial.headSha);
  if (classification.decision.labels.length > 0) {
    const current = await readCurrentCandidate(api, repository, triggerPrNumber, trigger.headSha, initial.currentMainSha!);
    if (!current.allowed) return skipped(current.reason, triggerPrNumber, trigger.headSha);
    const missing = classification.decision.labels.filter((name) => !current.pullRequest.labels.some((label) => label.name === name));
    if (missing.length) await api.addPullRequestLabels(repository, triggerPrNumber, missing);
    return skipped(
      `fresh classification blocks automatic merge (databaseChanged=${classification.decision.databaseChanged}, workflowChanged=${classification.decision.workflowChanged})`,
      triggerPrNumber,
      trigger.headSha,
    );
  }
  const initialProof = await validateReleaseProofs(api, repository, initial, trigger);
  if (!initialProof.allowed) return skipped(initialProof.reason, triggerPrNumber, initial.headSha);

  // Re-read the candidate and proof immediately before the write. A changed head or base gets a later run.
  const fresh = await validateReleaseCandidate(api, repository, triggerPrNumber, trigger.headSha);
  if (!fresh.allowed) return skipped(fresh.reasons.join("; "), triggerPrNumber, fresh.headSha);
  if (fresh.headSha !== initial.headSha || fresh.currentMainSha !== initial.currentMainSha)
    return skipped("pull request head or main changed during validation", triggerPrNumber, fresh.headSha);
  const freshProof = await validateReleaseProofs(api, repository, fresh, trigger);
  if (!freshProof.allowed) return skipped(freshProof.reason, triggerPrNumber, fresh.headSha);

  const current = await readCurrentCandidate(api, repository, triggerPrNumber, trigger.headSha, fresh.currentMainSha!);
  if (!current.allowed) return skipped(current.reason, triggerPrNumber, trigger.headSha);
  const holds: string[] = [RELEASE_CLASSIFICATION_LABELS.manual, RELEASE_CLASSIFICATION_LABELS.database, RELEASE_CLASSIFICATION_LABELS.workflow];
  const presentHolds = current.pullRequest.labels.map(({ name }) => name).filter((name) => holds.includes(name));
  if (presentHolds.length) return skipped(`manual release labels are present: ${presentHolds.sort().join(", ")}`, triggerPrNumber, trigger.headSha);
  await api.mergeSquash(repository, triggerPrNumber, current.pullRequest.head.sha);
  return { status: "merged", reason: "all exact-head release checks passed", pullRequest: triggerPrNumber, headSha: current.pullRequest.head.sha };
}

async function readCurrentCandidate(
  api: MergeGateApi,
  repository: string,
  pullRequest: number,
  expectedHeadSha: string,
  expectedBaseSha: string,
): Promise<{ allowed: true; pullRequest: PullRequestSnapshot } | { allowed: false; reason: string }> {
  const [currentPr, currentMainSha] = await Promise.all([
    api.getPullRequest(repository, pullRequest),
    api.getBranchSha(repository, RELEASE_MERGE_POLICY.baseBranch),
  ]);
  const problems = validatePullRequestIdentity(currentPr, repository, currentMainSha, expectedHeadSha);
  if (problems.length) return { allowed: false, reason: problems.join("; ") };
  if (currentMainSha !== expectedBaseSha) return { allowed: false, reason: "main changed during validation" };
  const ancestry = await api.compareAncestry(repository, currentMainSha, currentPr.head.sha);
  if (ancestry.status !== "ahead" || ancestry.mergeBaseSha !== currentMainSha)
    return { allowed: false, reason: "current main is not an ancestor of the exact pull request head" };
  return { allowed: true, pullRequest: currentPr };
}

export async function validateReleaseProofs(
  api: MergeGateApi,
  repository: string,
  candidate: CandidateValidation,
  trigger?: WorkflowRunTrigger,
): Promise<ReleaseProofResult> {
  if (trigger) {
    const triggerProblem = validateTrigger(trigger, repository);
    if (triggerProblem) return { allowed: false, reason: triggerProblem };
  }
  const pr = candidate.pullRequest!;
  const currentMainSha = candidate.currentMainSha!;
  const workflows = await api.getWorkflows(repository);
  const ciWorkflow = uniqueWorkflow(workflows, RELEASE_MERGE_POLICY.workflows.ci);
  const previewWorkflow = uniqueWorkflow(workflows, RELEASE_MERGE_POLICY.workflows.preview);
  if (!ciWorkflow || !previewWorkflow) return { allowed: false, reason: "Check or Release preview workflow is missing or ambiguous" };

  const [ciRuns, previewRuns, unresolvedThreads, reviews] = await Promise.all([
    api.listWorkflowRuns(repository, ciWorkflow.id, pr.head.sha),
    api.listWorkflowRuns(repository, previewWorkflow.id, pr.head.sha),
    api.getUnresolvedReviewThreadCount(repository, pr.number),
    api.listReviews(repository, pr.number),
  ]);
  const ci = latestRunForPullRequest(ciRuns, pr, repository);
  if (!ci) return { allowed: false, reason: "latest Check run for the exact head is missing" };
  const preview = latestRunForPullRequest(previewRuns, pr, repository);
  if (!preview) return { allowed: false, reason: "latest Release preview run for the exact head is missing" };
  if (!runMatchesPullRequest(ci, pr, repository, currentMainSha)) return { allowed: false, reason: "latest Check run used a stale base" };
  if (!runMatchesPullRequest(preview, pr, repository, currentMainSha)) return { allowed: false, reason: "latest Release preview run used a stale base" };
  if (!runSucceeded(ci)) return { allowed: false, reason: `latest Check run is ${runState(ci)}` };
  if (!runSucceeded(preview)) return { allowed: false, reason: `latest Release preview run is ${runState(preview)}` };

  if (trigger) {
    const triggerWorkflowId = trigger.workflowName === RELEASE_MERGE_POLICY.workflows.ci ? ciWorkflow.id : previewWorkflow.id;
    const triggerRuns = triggerWorkflowId === ciWorkflow.id ? ciRuns : previewRuns;
    const triggerRun = triggerRuns.find((run) => run.id === trigger.runId);
    if (!triggerRun || !runMatchesPullRequest(triggerRun, pr, repository, currentMainSha) || !runSucceeded(triggerRun))
      return { allowed: false, reason: "completion event is not a successful exact-head pull request run" };
  }

  const receipt = await api.getPreviewReceipt(repository, preview.id, RELEASE_MERGE_POLICY.previewArtifactName(pr.number, pr.head.sha));
  if (receipt === undefined) return { allowed: false, reason: "latest Release preview run has no receipt artifact" };
  const receiptProblems = validatePreviewReceipt(receipt, { pullRequest: pr.number, head: pr.head.sha, base: currentMainSha });
  if (receiptProblems.length) return { allowed: false, reason: receiptProblems.join("; ") };

  if (unresolvedThreads > 0) return { allowed: false, reason: "pull request has unresolved review threads" };
  const requestedChanges = latestChangeRequests(reviews);
  if (requestedChanges.length) return { allowed: false, reason: `latest review requests changes: ${requestedChanges.join(", ")}` };
  return { allowed: true, proofs: { ci, preview } };
}

export function latestRunForPullRequest(
  runs: WorkflowRun[],
  pr: PullRequestSnapshot,
  repository: string,
): WorkflowRun | undefined {
  return runs
    .filter((run) => runHasExactHeadAssociation(run, pr, repository))
    .sort((left, right) => right.run_number - left.run_number || (right.run_attempt ?? 1) - (left.run_attempt ?? 1) || right.created_at.localeCompare(left.created_at))[0];
}

export function latestChangeRequests(reviews: Review[]): string[] {
  const latest = new Map<string, { review: Review; index: number }>();
  reviews.forEach((review, index) => {
    const login = review.user?.login;
    if (!login || !review.submitted_at || review.state === "PENDING") return;
    const previous = latest.get(login);
    if (!previous || review.submitted_at > previous.review.submitted_at! || (review.submitted_at === previous.review.submitted_at && index > previous.index))
      latest.set(login, { review, index });
  });
  return [...latest.entries()]
    .filter(([, { review }]) => review.state === "CHANGES_REQUESTED")
    .map(([login]) => login)
    .sort();
}

function validateTrigger(trigger: WorkflowRunTrigger, repository: string): string | undefined {
  if (trigger.workflowName !== RELEASE_MERGE_POLICY.workflows.ci && trigger.workflowName !== RELEASE_MERGE_POLICY.workflows.preview)
    return "workflow completion is not from Check or Release preview";
  if (trigger.conclusion !== "success") return "triggering workflow did not succeed";
  if (trigger.event !== "pull_request") return "triggering workflow is not attached to a pull_request event";
  if (trigger.repositoryFullName !== repository || trigger.headRepositoryFullName !== repository)
    return "triggering workflow is not from the current repository";
  if (trigger.pullRequests.length !== 1) return "triggering workflow has no unique pull request association";
  const associated = trigger.pullRequests[0]!;
  if (associated.head.sha !== trigger.headSha || associated.head.ref !== trigger.headBranch || associated.head.repositoryFullName !== repository)
    return "triggering workflow pull request association does not match its exact head";
  if (associated.base.ref !== RELEASE_MERGE_POLICY.baseBranch || associated.base.repositoryFullName !== repository)
    return "triggering workflow pull request base is not main in the current repository";
  return undefined;
}

function runMatchesPullRequest(run: WorkflowRun, pr: PullRequestSnapshot, repository: string, currentMainSha: string): boolean {
  const association = exactHeadAssociation(run, pr, repository);
  return association !== undefined && association.base.sha === currentMainSha;
}

function runHasExactHeadAssociation(run: WorkflowRun, pr: PullRequestSnapshot, repository: string): boolean {
  return exactHeadAssociation(run, pr, repository) !== undefined;
}

function exactHeadAssociation(
  run: WorkflowRun,
  pr: PullRequestSnapshot,
  repository: string,
): WorkflowRun["pull_requests"][number] | undefined {
  if (run.event !== "pull_request" || run.head_sha !== pr.head.sha || run.head_branch !== pr.head.ref) return undefined;
  const matches = run.pull_requests.filter((association) =>
    association.number === pr.number && association.head.sha === pr.head.sha && association.head.ref === pr.head.ref &&
    association.head.repo?.full_name === repository && association.base.ref === RELEASE_MERGE_POLICY.baseBranch &&
    association.base.repo?.full_name === repository,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueWorkflow(workflows: Array<{ id: number; name: string; state: string }>, name: string): { id: number; name: string; state: string } | undefined {
  const matches = workflows.filter((workflow) => workflow.name === name && workflow.state === "active");
  return matches.length === 1 ? matches[0] : undefined;
}

function runSucceeded(run: WorkflowRun): boolean {
  return run.status === "completed" && run.conclusion === "success";
}

function runState(run: WorkflowRun): string {
  return run.status === "completed" ? run.conclusion ?? "without a conclusion" : run.status;
}

function skipped(reason: string, pullRequest?: number, headSha?: string): GateResult {
  return { status: "skipped", reason, ...(pullRequest ? { pullRequest } : {}), ...(headSha ? { headSha } : {}) };
}

export function parseWorkflowRunTrigger(event: unknown): WorkflowRunTrigger {
  if (!isRecord(event) || !isRecord(event.workflow_run) || !isRecord(event.repository)) throw new Error("workflow_run event payload is invalid");
  const run = event.workflow_run;
  const repository = event.repository;
  const pullRequests = Array.isArray(run.pull_requests) ? run.pull_requests.map((item) => {
    if (!isRecord(item) || !isRecord(item.head) || !isRecord(item.base)) throw new Error("workflow_run pull request association is invalid");
    return {
      number: numberField(item.number),
      head: {
        sha: stringField(item.head.sha),
        ref: stringField(item.head.ref),
        repositoryFullName: optionalRepoName(item.head.repo),
      },
      base: {
        ref: stringField(item.base.ref),
        sha: stringField(item.base.sha),
        repositoryFullName: optionalRepoName(item.base.repo),
      },
    };
  }) : [];
  return {
    runId: numberField(run.id),
    workflowName: stringField(run.name),
    event: stringField(run.event),
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    headSha: stringField(run.head_sha),
    headBranch: stringField(run.head_branch),
    repositoryFullName: stringField(repository.full_name),
    headRepositoryFullName: optionalRepoName(run.head_repository),
    pullRequests,
  };
}

export async function runWorkflowEvent(): Promise<GateResult> {
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!repository || !eventPath) throw new Error("GitHub workflow event environment is incomplete");
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as unknown;
  return runReleaseMergeGate(new GitHubApi(), repository, parseWorkflowRunTrigger(event));
}

function optionalRepoName(value: unknown): string | null {
  return isRecord(value) && typeof value.full_name === "string" ? value.full_name : null;
}

function stringField(value: unknown): string {
  if (typeof value !== "string") throw new Error("workflow_run event has a missing text field");
  return value;
}

function numberField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("workflow_run event has an invalid number field");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runWorkflowEvent();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
