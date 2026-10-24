import {
  RELEASE_MERGE_POLICY,
  validateChangedFiles,
  validatePullRequestIdentity,
  type CandidatePolicyResult,
  type ChangedFile,
  type FileContents,
  type PullRequestSnapshot,
} from "./policy.ts";

export type Ancestry = { status: string; mergeBaseSha: string };

export interface CandidateApi {
  getPullRequest(repository: string, number: number): Promise<PullRequestSnapshot>;
  getBranchSha(repository: string, branch: string): Promise<string>;
  compareAncestry(repository: string, baseSha: string, headSha: string): Promise<Ancestry>;
  listPullRequestFiles(repository: string, number: number): Promise<ChangedFile[]>;
  getFileAt(repository: string, path: string, ref: string): Promise<string | undefined>;
}

export type CandidateValidation = CandidatePolicyResult & {
  pullRequest?: PullRequestSnapshot;
  currentMainSha?: string;
  headSha?: string;
};

/** Validate the updater branch before any preview step checks out or runs its candidate. */
export async function validateReleaseCandidate(
  api: CandidateApi,
  repository: string,
  pullRequestNumber: number,
  expectedHeadSha?: string,
): Promise<CandidateValidation> {
  return validateCandidate(api, repository, pullRequestNumber, expectedHeadSha, false, true);
}

/** Validate release allowlisting for a guarded branch refresh, where ancestry is expected to be stale. */
export async function validateReleaseBranchUpdateCandidate(
  api: CandidateApi,
  repository: string,
  pullRequestNumber: number,
  expectedHeadSha?: string,
): Promise<CandidateValidation> {
  return validateCandidate(api, repository, pullRequestNumber, expectedHeadSha, true, false);
}

async function validateCandidate(
  api: CandidateApi,
  repository: string,
  pullRequestNumber: number,
  expectedHeadSha: string | undefined,
  allowStaleBase: boolean,
  requireCurrentMainAncestor: boolean,
): Promise<CandidateValidation> {
  const pr = await api.getPullRequest(repository, pullRequestNumber);
  const currentMainSha = await api.getBranchSha(repository, RELEASE_MERGE_POLICY.baseBranch);
  const reasons = validatePullRequestIdentity(pr, repository, currentMainSha, expectedHeadSha, { allowStaleBase });
  if (reasons.length) return { allowed: false, reasons, pullRequest: pr, currentMainSha, headSha: pr.head.sha };

  if (requireCurrentMainAncestor) {
    const ancestry = await api.compareAncestry(repository, currentMainSha, pr.head.sha);
    if (ancestry.status !== "ahead" || ancestry.mergeBaseSha !== currentMainSha)
      return { allowed: false, reasons: ["current main is not an ancestor of the exact pull request head"], pullRequest: pr, currentMainSha, headSha: pr.head.sha };
  }

  const files = await api.listPullRequestFiles(repository, pullRequestNumber);
  const contentPaths = new Set<string>([
    RELEASE_MERGE_POLICY.upstreamPinsPath,
    RELEASE_MERGE_POLICY.poolPinsPath,
  ]);
  for (const { filename } of files) {
    if (
      filename === RELEASE_MERGE_POLICY.providerTablePath ||
      filename === RELEASE_MERGE_POLICY.patchManifestPath ||
      /^patches\/[A-Za-z0-9][A-Za-z0-9._-]*\.patch$/.test(filename) ||
      /^scripts\/releases\/receipts\/(?:tools|home|node)\.json$/.test(filename)
    ) contentPaths.add(filename);
  }

  const contents: FileContents = {};
  for (const path of contentPaths) {
    const [base, candidate] = await Promise.all([
      api.getFileAt(repository, path, currentMainSha),
      api.getFileAt(repository, path, pr.head.sha),
    ]);
    contents[path] = { ...(base === undefined ? {} : { base }), ...(candidate === undefined ? {} : { candidate }) };
  }

  const filePolicy = validateChangedFiles(files, contents);
  if (filePolicy.releaseKey && pr.head.ref !== `${RELEASE_MERGE_POLICY.updaterBranchPrefix}${filePolicy.releaseKey}`)
    filePolicy.reasons.push("updater branch does not match the release key");
  filePolicy.allowed = filePolicy.reasons.length === 0;
  return {
    ...filePolicy,
    pullRequest: pr,
    currentMainSha,
    headSha: pr.head.sha,
  };
}
