import type { SourceComparison } from "./types.ts";

export type GitHubFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};
export type GitHubComparison = SourceComparison & { aheadBy: number; behindBy: number; mergeBaseSha?: string };
export type GitHubResponseError = Error & { status: number };

export class GitHubApi {
  private readonly cache = new Map<string, Promise<unknown>>();
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async get<T>(path: string): Promise<T> {
    const url = path.startsWith("https://") ? path : `https://api.github.com/${path.replace(/^\//, "")}`;
    const cached = this.cache.get(url);
    if (cached) return (await cached) as T;
    const request = this.fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "basalt-release-updater",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    }).then(async (response) => {
      if (!response.ok) throw responseError(response.status, path);
      return response.json() as Promise<T>;
    });
    this.cache.set(url, request);
    return (await request) as T;
  }

  async request<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("https://") ? path : `https://api.github.com/${path.replace(/^\//, "")}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "basalt-release-updater",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw responseError(response.status, path);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  async compare(repository: string, base: string, candidate: string): Promise<GitHubComparison> {
    if (base === candidate)
      return { complete: true, status: "identical", aheadBy: 0, behindBy: 0, files: [] };

    const pageSize = 100;
    const path = `repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(candidate)}`;
    const first = await this.get<CompareResponse>(`${path}?per_page=${pageSize}&page=1`);
    const firstPage = first.files ?? [];
    const files = [...firstPage];
    const expected = first.changed_files;
    if (typeof expected === "number" && Number.isInteger(expected) && expected >= 0) {
      const pages = Math.ceil(expected / pageSize);
      for (let page = 2; page <= pages && page <= 3; page++) {
        const next = await this.get<CompareResponse>(`${path}?per_page=${pageSize}&page=${page}`);
        files.push(...(next.files ?? []));
      }
      return {
        complete: expected < 300 && files.length === expected,
        status: first.status,
        aheadBy: first.ahead_by ?? 0,
        behindBy: first.behind_by ?? 0,
        ...(first.merge_base_commit?.sha ? { mergeBaseSha: first.merge_base_commit.sha } : {}),
        files,
      };
    }

    let lastPageLength = firstPage.length;
    for (let page = 2; lastPageLength === pageSize && page <= 3; page++) {
      const next = await this.get<CompareResponse>(`${path}?per_page=${pageSize}&page=${page}`);
      const nextFiles = next.files ?? [];
      files.push(...nextFiles);
      lastPageLength = nextFiles.length;
    }

    return {
      complete: lastPageLength < pageSize && files.length < 300,
      status: first.status,
      aheadBy: first.ahead_by ?? 0,
      behindBy: first.behind_by ?? 0,
      ...(first.merge_base_commit?.sha ? { mergeBaseSha: first.merge_base_commit.sha } : {}),
      files,
    };
  }

  async compareTrees(repository: string, base: string, candidate: string): Promise<GitHubComparison> {
    const [baseTree, candidateTree] = await Promise.all([
      this.get<TreeResponse>(`repos/${repository}/git/trees/${base}?recursive=1`),
      this.get<TreeResponse>(`repos/${repository}/git/trees/${candidate}?recursive=1`),
    ]);
    const complete = baseTree.truncated === false && candidateTree.truncated === false &&
      Array.isArray(baseTree.tree) && Array.isArray(candidateTree.tree) &&
      baseTree.tree.every(validTreeEntry) && candidateTree.tree.every(validTreeEntry);
    if (!Array.isArray(baseTree.tree) || !Array.isArray(candidateTree.tree))
      return { complete: false, status: "diverged", aheadBy: 0, behindBy: 0, files: [] };

    const filesByTree = (tree: TreeEntry[]) => new Map(
      tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, `${entry.type}:${entry.mode}:${entry.sha}`]),
    );
    const before = filesByTree(baseTree.tree);
    const after = filesByTree(candidateTree.tree);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const files = [...paths]
      .filter((path) => before.get(path) !== after.get(path))
      .sort()
      .map((filename) => ({ filename }));
    return { complete, status: "diverged", aheadBy: 0, behindBy: 0, files };
  }
}

function responseError(status: number, path: string): GitHubResponseError {
  const error = new Error(`GitHub API ${status} for ${path}`) as GitHubResponseError;
  error.status = status;
  return error;
}

type CompareResponse = {
  status?: "ahead" | "behind" | "identical" | "diverged";
  ahead_by?: number;
  behind_by?: number;
  changed_files?: number;
  merge_base_commit?: { sha?: string } | null;
  files?: GitHubFile[];
};

type TreeEntry = { path: string; mode: string; sha: string; type: "blob" | "tree" | "commit" };
type TreeResponse = { truncated: boolean; tree: TreeEntry[] };

function validTreeEntry(value: TreeEntry): boolean {
  return typeof value.path === "string" && typeof value.sha === "string" &&
    typeof value.mode === "string" && ["blob", "tree", "commit"].includes(value.type);
}
