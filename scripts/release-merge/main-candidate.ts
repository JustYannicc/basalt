import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type MainCandidate = { head: string };

export type MainCandidateFetch = (url: string, init: RequestInit) => Promise<Response>;

const sha = /^[a-f0-9]{40}$/;
const comparePage = 100;

async function json(fetcher: MainCandidateFetch, token: string, url: string): Promise<unknown> {
  const response = await fetcher(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "basalt-release",
    },
  });
  if (!response.ok) throw new Error(`GitHub request for the main release candidate failed with HTTP ${response.status}`);
  return response.json();
}

/** Reads main candidates from one repository's GitHub API. */
class MainHistory {
  readonly #get: (path: string) => Promise<unknown>;

  constructor(repository: string, token: string, fetcher: MainCandidateFetch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must identify the repository");
    this.#get = (path) => json(fetcher, token, `https://api.github.com/repos/${repository}${path}`);
  }

  async mainHead(): Promise<string> {
    const main = await this.#get("/commits/main") as { sha?: unknown };
    if (typeof main.sha !== "string") throw new Error("GitHub returned no main head");
    return main.sha.toLowerCase();
  }

  async #compare(ancestor: string, descendant: string, page = 1): Promise<{ contained: boolean; total: number; commits: string[] }> {
    const comparison = await this.#get(`/compare/${ancestor}...${descendant}?per_page=${comparePage}&page=${page}`) as
      { status?: unknown; total_commits?: unknown; commits?: unknown };
    return {
      // "ahead" means `descendant` is `ancestor` plus newer commits; "behind" or "diverged" means it doesn't contain it.
      contained: comparison.status === "identical" || comparison.status === "ahead",
      total: typeof comparison.total_commits === "number" ? comparison.total_commits : 0,
      commits: Array.isArray(comparison.commits)
        ? comparison.commits.map((commit: { sha?: unknown }) => String(commit.sha).toLowerCase()).filter((value) => sha.test(value))
        : [],
    };
  }

  async contains(ancestor: string, descendant: string): Promise<boolean> {
    return ancestor === descendant || (await this.#compare(ancestor, descendant)).contained;
  }

  /** Commits on main after `candidate`, newest first; GitHub lists them oldest first, a page at a time. */
  async *newerThan(candidate: string, mainHead: string): AsyncGenerator<string> {
    if (candidate === mainHead) return;
    const first = await this.#compare(candidate, mainHead);
    if (!first.contained) throw new Error("main does not contain the release candidate");
    for (let page = Math.max(1, Math.ceil(first.total / comparePage)); page >= 1; page--) {
      const { commits } = page === 1 ? first : await this.#compare(candidate, mainHead, page);
      yield* [...commits].reverse();
    }
  }

  async passedPushCheck(commit: string): Promise<boolean> {
    const query = new URLSearchParams({ head_sha: commit, event: "push", branch: "main", status: "completed", per_page: "100" });
    const runs = await this.#get(`/actions/workflows/ci.yml/runs?${query}`) as { workflow_runs?: unknown };
    if (!Array.isArray(runs.workflow_runs)) throw new Error("GitHub returned no Check runs for the main release candidate");
    return runs.workflow_runs.some((run: { head_sha?: unknown; conclusion?: unknown; event?: unknown; path?: unknown }) =>
      typeof run.head_sha === "string" && run.head_sha.toLowerCase() === commit &&
      run.event === "push" && run.conclusion === "success" && run.path === ".github/workflows/ci.yml");
  }

  async isReleaseUpdate(commit: string): Promise<boolean> {
    const pulls = await this.#get(`/commits/${commit}/pulls`);
    if (!Array.isArray(pulls)) throw new Error("GitHub returned no pull request list for the main release candidate");
    return pulls.some((pull: { head?: { ref?: unknown } }) => typeof pull.head?.ref === "string" && pull.head.ref.startsWith("release-updates/"));
  }
}

function fullSha(value: string, what: string): string {
  const commit = value.trim().toLowerCase();
  if (!sha.test(commit)) throw new Error(`the ${what} must be a full commit SHA`);
  return commit;
}

/**
 * A main commit may be released manually only when the push Check from the CI workflow passed on
 * exactly that commit. Without a candidate it's the checked-out commit, which must be the current
 * main head. A candidate, such as the commit Deploy handed off or the one a backup was taken for,
 * only has to be on main, so main moving past it doesn't invalidate it.
 */
export async function validateMainCandidate(
  repository: string,
  token: string,
  checkedOut: string,
  candidate?: string,
  fetcher: MainCandidateFetch = fetch,
): Promise<MainCandidate> {
  const history = new MainHistory(repository, token, fetcher);
  const head = candidate === undefined ? fullSha(checkedOut, "checked-out main commit") : fullSha(candidate, "release candidate");
  const mainHead = await history.mainHead();
  if (candidate === undefined && mainHead !== head) throw new Error("the checked-out commit is not the current main head");
  if (!await history.contains(head, mainHead)) throw new Error("main does not contain the release candidate");
  if (!await history.passedPushCheck(head)) throw new Error("the main release candidate has no successful push Check");
  // Upstream update PRs must keep their live preview proof, which only the PR-based manual release checks.
  if (await history.isReleaseUpdate(head))
    throw new Error("the release candidate is a release update; release it through Manual release with its pull request");
  return { head };
}

/**
 * The newest main commit after `candidate` that contains it, passed its push Check and isn't a
 * release update, or undefined when none does. A release dispatched for `candidate` can replace a
 * newer commit's pending Deploy run, so it releases that newer commit instead.
 */
export async function newerMainCandidate(
  repository: string,
  token: string,
  candidate: string,
  fetcher: MainCandidateFetch = fetch,
): Promise<string | undefined> {
  const history = new MainHistory(repository, token, fetcher);
  const base = fullSha(candidate, "release candidate");
  const mainHead = await history.mainHead();
  for await (const commit of history.newerThan(base, mainHead)) {
    // A merged side branch lists commits that don't contain the candidate; main's head was just compared.
    if (await history.passedPushCheck(commit) && !await history.isReleaseUpdate(commit) &&
        (commit === mainHead || await history.contains(base, commit)))
      return commit;
  }
  return undefined;
}

export function mainCandidateOutputLines(candidate: MainCandidate): string {
  if (!sha.test(candidate.head)) throw new Error("main candidate output contains invalid values");
  return `head=${candidate.head}\n`;
}

/**
 * With no argument, validates the checked-out main head or `MAIN_RELEASE_CANDIDATE` exactly.
 * `newest` releases the newest valid main commit containing the candidate, falling back to the
 * candidate. `newer` only reports that newer commit, if any, for Deploy to hand off.
 */
async function runMainCandidateCli(env = process.env, mode = process.argv[2]): Promise<void> {
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (env.GITHUB_REF !== "refs/heads/main") throw new Error("manual main releases run only from main");
  if (mode !== undefined && mode !== "newest" && mode !== "newer") throw new Error("usage: main-candidate.ts [newest|newer]");
  const repository = env.GITHUB_REPOSITORY ?? "";
  const requested = env.MAIN_RELEASE_CANDIDATE?.trim() || undefined;
  if ((env.MAIN_RELEASE_REQUIRE_CANDIDATE === "true" || mode === "newer") && !requested)
    throw new Error("the release candidate is missing; start a new release");
  let lines: string;
  if (mode === "newer") {
    const newer = await newerMainCandidate(repository, token, requested!);
    lines = `newer=${newer ?? ""}\n`;
  } else {
    const chosen = mode === "newest" && requested ? await newerMainCandidate(repository, token, requested) ?? requested : requested;
    lines = mainCandidateOutputLines(await validateMainCandidate(repository, token, env.MAIN_RELEASE_CHECKOUT ?? "", chosen));
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(lines);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runMainCandidateCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
