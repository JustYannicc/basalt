import type { CandidateValidation } from "./candidate.ts";
import { RELEASE_MERGE_POLICY, validateCheckRunReceipt, validatePreviewReceipt, type PullRequestSnapshot } from "./policy.ts";
import type { MergeGateApi, Review, WorkflowRun } from "./github.ts";

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

export type ReleaseProofResult = { allowed: true; proofs: { ci: WorkflowRun; preview: WorkflowRun } } | { allowed: false; reason: string };

export async function validateReleaseProofs(
  api: MergeGateApi,
  repository: string,
  candidate: CandidateValidation,
  trigger?: WorkflowRunTrigger,
): Promise<ReleaseProofResult> {
  if (trigger) {
    const triggerProblem = validateWorkflowRunTrigger(trigger, repository);
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

  const checkAttempt = ci.run_attempt ?? 1;
  if (!Number.isSafeInteger(ci.id) || ci.id < 1 || !Number.isSafeInteger(checkAttempt) || checkAttempt < 1)
    return { allowed: false, reason: "latest Check run identity is invalid" };
  const checkReceipt = await api.getCheckReceipt(
    repository,
    ci.id,
    RELEASE_MERGE_POLICY.checkArtifactName(pr.number, pr.head.sha, checkAttempt),
  );
  if (checkReceipt === undefined) return { allowed: false, reason: "latest Check run has no merge-result receipt" };
  const checkReceiptProblems = validateCheckRunReceipt(checkReceipt, {
    repository,
    pullRequest: pr.number,
    runId: ci.id,
    runAttempt: checkAttempt,
    head: pr.head.sha,
    base: currentMainSha,
  });
  if (checkReceiptProblems.length) return { allowed: false, reason: checkReceiptProblems.join("; ") };

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

export function validateWorkflowRunTrigger(trigger: WorkflowRunTrigger, repository: string): string | undefined {
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
