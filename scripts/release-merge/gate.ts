import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateReleaseBranchUpdateCandidate, validateReleaseCandidate } from "./candidate.ts";
import { RELEASE_CLASSIFICATION_LABELS, validateReleaseClassification } from "./classification.ts";
import { GitHubApi, type MergeGateApi } from "./github.ts";
import { validateReleaseProofs, validateWorkflowRunTrigger, type WorkflowRunTrigger } from "./proofs.ts";
import {
  RELEASE_MERGE_POLICY,
  validatePullRequestIdentity,
  type PullRequestSnapshot,
} from "./policy.ts";

export { validateReleaseProofs };
export type { ReleaseProofResult, WorkflowRunTrigger } from "./proofs.ts";

export type GateResult = { status: "merged" | "skipped"; reason: string; pullRequest?: number; headSha?: string };

export async function runReleaseMergeGate(
  api: MergeGateApi,
  repository: string,
  trigger: WorkflowRunTrigger,
): Promise<GateResult> {
  const triggerProblem = validateWorkflowRunTrigger(trigger, repository);
  if (triggerProblem) return skipped(triggerProblem);
  const triggerPrNumber = trigger.pullRequests[0]!.number;

  const initial = await validateReleaseCandidate(api, repository, triggerPrNumber, trigger.headSha);
  if (!initial.allowed) {
    const update = await updateStaleReleaseBranch(api, repository, triggerPrNumber, trigger.headSha);
    return update ?? skipped(initial.reasons.join("; "), triggerPrNumber, initial.headSha);
  }
  const rawClassification = await api.classifyCandidate(repository, triggerPrNumber, initial.currentMainSha!, initial.headSha!);
  const classification = validateReleaseClassification(rawClassification, { base: initial.currentMainSha!, candidate: initial.headSha! });
  if (!classification.decision) return skipped(classification.reasons.join("; "), triggerPrNumber, initial.headSha);
  if (classification.decision.labels.length > 0) {
    const current = await readCurrentCandidate(api, repository, triggerPrNumber, trigger.headSha, initial.currentMainSha!);
    if (!current.allowed) {
      const update = await updateStaleReleaseBranch(api, repository, triggerPrNumber, trigger.headSha);
      return update ?? skipped(current.reason, triggerPrNumber, trigger.headSha);
    }
    const missing = classification.decision.labels.filter((name) => !current.pullRequest.labels.some((label) => label.name === name));
    if (missing.length) await api.addPullRequestLabels(repository, triggerPrNumber, missing);
    return skipped(
      `fresh classification blocks automatic merge (databaseChanged=${classification.decision.databaseChanged}, workflowChanged=${classification.decision.workflowChanged})`,
      triggerPrNumber,
      trigger.headSha,
    );
  }
  const initialProof = await validateReleaseProofs(api, repository, initial, trigger);
  if (!initialProof.allowed) {
    const update = await updateStaleReleaseBranch(api, repository, triggerPrNumber, trigger.headSha);
    return update ?? skipped(initialProof.reason, triggerPrNumber, initial.headSha);
  }

  // Re-read the candidate and proof immediately before the write. A changed head or base gets a later run.
  const fresh = await validateReleaseCandidate(api, repository, triggerPrNumber, trigger.headSha);
  if (!fresh.allowed) {
    const update = await updateStaleReleaseBranch(api, repository, triggerPrNumber, trigger.headSha);
    return update ?? skipped(fresh.reasons.join("; "), triggerPrNumber, fresh.headSha);
  }
  if (fresh.headSha !== initial.headSha || fresh.currentMainSha !== initial.currentMainSha)
    return skipped("pull request head or main changed during validation", triggerPrNumber, fresh.headSha);
  const freshProof = await validateReleaseProofs(api, repository, fresh, trigger);
  if (!freshProof.allowed) {
    const update = await updateStaleReleaseBranch(api, repository, triggerPrNumber, trigger.headSha);
    return update ?? skipped(freshProof.reason, triggerPrNumber, fresh.headSha);
  }

  const current = await readCurrentCandidate(api, repository, triggerPrNumber, trigger.headSha, fresh.currentMainSha!);
  if (!current.allowed) {
    const update = await updateStaleReleaseBranch(api, repository, triggerPrNumber, trigger.headSha);
    return update ?? skipped(current.reason, triggerPrNumber, trigger.headSha);
  }

  // Re-read both proof sets and refs near the merge write. A stale base must get a fresh branch update and new runs.
  const finalProof = await validateReleaseProofs(api, repository, fresh, trigger);
  if (!finalProof.allowed) {
    const update = await updateStaleReleaseBranch(api, repository, triggerPrNumber, trigger.headSha);
    return update ?? skipped(finalProof.reason, triggerPrNumber, trigger.headSha);
  }
  const atMerge = await readCurrentCandidate(api, repository, triggerPrNumber, trigger.headSha, fresh.currentMainSha!);
  if (!atMerge.allowed) {
    const update = await updateStaleReleaseBranch(api, repository, triggerPrNumber, trigger.headSha);
    return update ?? skipped(atMerge.reason, triggerPrNumber, trigger.headSha);
  }

  const holds: string[] = [RELEASE_CLASSIFICATION_LABELS.manual, RELEASE_CLASSIFICATION_LABELS.database, RELEASE_CLASSIFICATION_LABELS.workflow];
  const presentHolds = atMerge.pullRequest.labels.map(({ name }) => name).filter((name) => holds.includes(name));
  if (presentHolds.length) return skipped(`manual release labels are present: ${presentHolds.sort().join(", ")}`, triggerPrNumber, trigger.headSha);
  await api.mergeSquash(repository, triggerPrNumber, atMerge.pullRequest.head.sha);
  return { status: "merged", reason: "all exact-head release checks passed", pullRequest: triggerPrNumber, headSha: atMerge.pullRequest.head.sha };
}

async function updateStaleReleaseBranch(
  api: MergeGateApi,
  repository: string,
  pullRequest: number,
  expectedHeadSha: string,
): Promise<GateResult | undefined> {
  const candidate = await validateReleaseBranchUpdateCandidate(api, repository, pullRequest, expectedHeadSha);
  if (!candidate.allowed || !candidate.pullRequest || !candidate.currentMainSha || !candidate.headSha) return undefined;

  const ancestry = await api.compareAncestry(repository, candidate.currentMainSha, candidate.headSha);
  if (candidate.pullRequest.base.sha === candidate.currentMainSha && ancestry.status === "ahead" && ancestry.mergeBaseSha === candidate.currentMainSha)
    return undefined;

  const fresh = await validateReleaseBranchUpdateCandidate(api, repository, pullRequest, expectedHeadSha);
  if (!fresh.allowed || !fresh.pullRequest || !fresh.currentMainSha || !fresh.headSha)
    return skipped(`release branch could not be refreshed: ${fresh.reasons.join("; ")}`, pullRequest, expectedHeadSha);
  if (fresh.headSha !== candidate.headSha || fresh.currentMainSha !== candidate.currentMainSha ||
    fresh.pullRequest.head.ref !== candidate.pullRequest.head.ref || fresh.pullRequest.base.sha !== candidate.pullRequest.base.sha)
    return skipped("release candidate refs changed while checking branch freshness", pullRequest, fresh.headSha);

  const freshAncestry = await api.compareAncestry(repository, fresh.currentMainSha, fresh.headSha);
  if (fresh.pullRequest.base.sha === fresh.currentMainSha && freshAncestry.status === "ahead" && freshAncestry.mergeBaseSha === fresh.currentMainSha)
    return undefined;

  const result = await api.updatePullRequestBranch(repository, pullRequest, fresh.headSha);
  if (result === "accepted")
    return skipped("stale release branch update accepted; waiting for new Check and Release preview runs", pullRequest, fresh.headSha);

  const [latestPullRequest, latestMainSha] = await Promise.all([
    api.getPullRequest(repository, pullRequest),
    api.getBranchSha(repository, RELEASE_MERGE_POLICY.baseBranch),
  ]);
  if (latestPullRequest.head.sha !== fresh.headSha || latestPullRequest.base.sha !== fresh.currentMainSha || latestMainSha !== fresh.currentMainSha)
    return skipped("release candidate refs changed during branch update; waiting for new proofs", pullRequest, latestPullRequest.head.sha);
  return skipped("GitHub rejected the expected-head release branch update", pullRequest, fresh.headSha);
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
