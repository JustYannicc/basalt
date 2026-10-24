import { classifyCandidateFromTrustedMain } from "./trusted-classifier.ts";
import { getPreviewReceiptArtifact } from "./preview-artifact.ts";
import type { Ancestry } from "./candidate.ts";
import type { ChangedFile, PullRequestSnapshot } from "./policy.ts";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const MAX_PAGES = 30;

export type Review = { user: { login: string; type?: string } | null; state: string; submitted_at: string | null };
export type WorkflowRun = {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  run_number: number;
  run_attempt?: number;
  created_at: string;
  run_started_at?: string | null;
  pull_requests: Array<{
    number: number;
    head: { ref: string; sha: string; repo: { full_name: string } | null };
    base: { ref: string; sha: string; repo: { full_name: string } | null };
  }>;
};

export interface MergeGateApi {
  getPullRequest(repository: string, number: number): Promise<PullRequestSnapshot>;
  getBranchSha(repository: string, branch: string): Promise<string>;
  compareAncestry(repository: string, baseSha: string, headSha: string): Promise<Ancestry>;
  listPullRequestFiles(repository: string, number: number): Promise<ChangedFile[]>;
  getFileAt(repository: string, path: string, ref: string): Promise<string | undefined>;
  classifyCandidate(repository: string, pullRequest: number, baseSha: string, headSha: string): Promise<unknown>;
  getWorkflows(repository: string): Promise<Array<{ id: number; name: string; state: string }>>;
  listWorkflowRuns(repository: string, workflowId: number, headSha: string): Promise<WorkflowRun[]>;
  getUnresolvedReviewThreadCount(repository: string, number: number): Promise<number>;
  listReviews(repository: string, number: number): Promise<Review[]>;
  getPreviewReceipt(repository: string, runId: number, artifactName: string): Promise<unknown | undefined>;
  addPullRequestLabels(repository: string, number: number, labels: string[]): Promise<void>;
  mergeSquash(repository: string, number: number, expectedHeadSha: string): Promise<void>;
}

export class GitHubApi implements MergeGateApi {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    fetchImpl: typeof fetch = fetch,
  ) {
    if (!token) throw new Error("GH_TOKEN is required");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async getPullRequest(repository: string, number: number): Promise<PullRequestSnapshot> {
    return await this.json(`/repos/${repositoryPath(repository)}/pulls/${number}`) as PullRequestSnapshot;
  }

  async getBranchSha(repository: string, branch: string): Promise<string> {
    const result = await this.json(`/repos/${repositoryPath(repository)}/commits/${encodeURIComponent(branch)}`) as { sha?: unknown };
    if (typeof result.sha !== "string") throw new Error("GitHub did not return the requested branch SHA");
    return result.sha;
  }

  async compareAncestry(repository: string, baseSha: string, headSha: string): Promise<Ancestry> {
    const result = await this.json(`/repos/${repositoryPath(repository)}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`) as {
      status?: string;
      merge_base_commit?: { sha?: string } | null;
    };
    return { status: result.status ?? "unknown", mergeBaseSha: result.merge_base_commit?.sha ?? "" };
  }

  async listPullRequestFiles(repository: string, number: number): Promise<ChangedFile[]> {
    const result: ChangedFile[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const files = await this.json(`/repos/${repositoryPath(repository)}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`) as Array<Partial<ChangedFile>>;
      if (!Array.isArray(files)) throw new Error("GitHub returned an invalid pull request file list");
      result.push(...files.map((file) => ({
        filename: typeof file.filename === "string" ? file.filename : "",
        status: typeof file.status === "string" ? file.status : "unknown",
        additions: Number.isSafeInteger(file.additions) ? file.additions as number : -1,
        deletions: Number.isSafeInteger(file.deletions) ? file.deletions as number : -1,
        changes: Number.isSafeInteger(file.changes) ? file.changes as number : -1,
      })));
      if (files.length < PAGE_SIZE) return result;
    }
    throw new Error("GitHub pull request file list may be truncated");
  }

  async getFileAt(repository: string, path: string, ref: string): Promise<string | undefined> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await this.fetchImpl(`${API_ROOT}/repos/${repositoryPath(repository)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status} while reading release metadata`);
    const file = await response.json() as { type?: string; encoding?: string; content?: string; size?: number };
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || (file.size ?? 0) > 1_000_000)
      throw new Error("GitHub returned unsupported release metadata");
    return Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
  }

  async classifyCandidate(repository: string, pullRequest: number, baseSha: string, headSha: string): Promise<unknown> {
    return classifyCandidateFromTrustedMain(repository, pullRequest, baseSha, headSha, this.token);
  }

  async getWorkflows(repository: string): Promise<Array<{ id: number; name: string; state: string }>> {
    const workflows: Array<{ id: number; name: string; state: string }> = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.json(`/repos/${repositoryPath(repository)}/actions/workflows?per_page=${PAGE_SIZE}&page=${page}`) as { workflows?: Array<{ id: number; name: string; state: string }> };
      const current = result.workflows;
      if (!Array.isArray(current)) throw new Error("GitHub returned an invalid workflow list");
      workflows.push(...current);
      if (current.length < PAGE_SIZE) return workflows;
    }
    throw new Error("GitHub workflow list may be truncated");
  }

  async listWorkflowRuns(repository: string, workflowId: number, headSha: string): Promise<WorkflowRun[]> {
    const result = await this.json(`/repos/${repositoryPath(repository)}/actions/workflows/${workflowId}/runs?head_sha=${encodeURIComponent(headSha)}&per_page=${PAGE_SIZE}`) as { workflow_runs?: WorkflowRun[]; total_count?: number };
    const runs = result.workflow_runs;
    if (!Array.isArray(runs)) throw new Error("GitHub returned an invalid workflow run list");
    if ((result.total_count ?? runs.length) > runs.length) throw new Error("GitHub returned a truncated workflow run list");
    return runs;
  }

  async getUnresolvedReviewThreadCount(repository: string, number: number): Promise<number> {
    const [owner, name] = splitRepository(repository);
    let cursor: string | null = null;
    let unresolved = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.json("/graphql", {
        method: "POST",
        body: JSON.stringify({
          query: "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}",
          variables: { owner, name, number, cursor },
        }),
      }) as GraphQLThreadsResponse;
      const threads = result.data?.repository?.pullRequest?.reviewThreads;
      if (!threads) throw new Error("GitHub did not return pull request review threads");
      unresolved += threads.nodes.filter(({ isResolved }) => isResolved !== true).length;
      if (!threads.pageInfo.hasNextPage) return unresolved;
      if (!threads.pageInfo.endCursor) throw new Error("GitHub returned incomplete review thread pagination");
      cursor = threads.pageInfo.endCursor;
    }
    throw new Error("GitHub review thread list may be truncated");
  }

  async listReviews(repository: string, number: number): Promise<Review[]> {
    const reviews: Review[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const current = await this.json(`/repos/${repositoryPath(repository)}/pulls/${number}/reviews?per_page=${PAGE_SIZE}&page=${page}`) as Review[];
      if (!Array.isArray(current)) throw new Error("GitHub returned an invalid review list");
      reviews.push(...current);
      if (current.length < PAGE_SIZE) return reviews;
    }
    throw new Error("GitHub review list may be truncated");
  }

  async getPreviewReceipt(repository: string, runId: number, artifactName: string): Promise<unknown | undefined> {
    return getPreviewReceiptArtifact(this.fetchImpl, (extra) => this.headers(extra), repository, runId, artifactName);
  }

  async addPullRequestLabels(repository: string, number: number, labels: string[]): Promise<void> {
    const unique = [...new Set(labels)];
    if (unique.length === 0) return;
    const response = await this.json(`/repos/${repositoryPath(repository)}/issues/${number}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: unique }),
    }) as Array<{ name?: unknown }>;
    if (!Array.isArray(response) || unique.some((label) => !response.some((item) => item.name === label)))
      throw new Error("GitHub did not confirm all release classification labels");
  }

  async mergeSquash(repository: string, number: number, expectedHeadSha: string): Promise<void> {
    const response = await this.fetchImpl(`${API_ROOT}/repos/${repositoryPath(repository)}/pulls/${number}/merge`, {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ merge_method: "squash", sha: expectedHeadSha }),
    });
    if (!response.ok) throw new Error(`GitHub refused the expected-head squash merge (HTTP ${response.status})`);
    const result = await response.json() as { merged?: boolean };
    if (result.merged !== true) throw new Error("GitHub did not confirm the squash merge");
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = path === "/graphql" ? "https://api.github.com/graphql" : `${API_ROOT}${path}`;
    const response = await this.fetchImpl(url, { ...init, headers: this.headers(init.headers) });
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
    const result = await response.json() as { message?: string; errors?: unknown[] };
    if (Array.isArray(result.errors) && result.errors.length) throw new Error("GitHub GraphQL request failed");
    return result;
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("X-GitHub-Api-Version", API_VERSION);
    headers.set("User-Agent", "basalt-release-merge-gate");
    return headers;
  }
}

function repositoryPath(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}

function splitRepository(repository: string): [string, string] {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error("GITHUB_REPOSITORY is invalid");
  return [parts[0]!, parts[1]!];
}

type GraphQLThreadsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes: Array<{ isResolved: boolean }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    } | null;
  };
  errors?: unknown[];
};
