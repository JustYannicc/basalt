import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type MainCandidate = { head: string };

export type MainCandidateFetch = (url: string, init: RequestInit) => Promise<Response>;

const sha = /^[a-f0-9]{40}$/;

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

/**
 * The current main commit may be released manually only when the push Check from the CI workflow
 * passed on exactly that commit. An expected head pins the commit the backup was taken for.
 */
export async function validateMainCandidate(
  repository: string,
  token: string,
  checkedOut: string,
  expectedHead?: string,
  fetcher: MainCandidateFetch = fetch,
): Promise<MainCandidate> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must identify the repository");
  const head = checkedOut.trim().toLowerCase();
  if (!sha.test(head)) throw new Error("the checked-out main commit must be a full commit SHA");
  if (expectedHead !== undefined && expectedHead.toLowerCase() !== head)
    throw new Error("main changed since this manual release was backed up; start a new release");
  const api = `https://api.github.com/repos/${repository}`;
  const main = await json(fetcher, token, `${api}/commits/main`) as { sha?: unknown };
  if (typeof main.sha !== "string" || main.sha.toLowerCase() !== head)
    throw new Error("the checked-out commit is not the current main head");
  const query = new URLSearchParams({ head_sha: head, event: "push", branch: "main", status: "completed", per_page: "100" });
  const runs = await json(fetcher, token, `${api}/actions/workflows/ci.yml/runs?${query}`) as { workflow_runs?: unknown };
  if (!Array.isArray(runs.workflow_runs)) throw new Error("GitHub returned no Check runs for the main release candidate");
  const passed = runs.workflow_runs.some((run: { head_sha?: unknown; conclusion?: unknown; event?: unknown; path?: unknown }) =>
    typeof run.head_sha === "string" && run.head_sha.toLowerCase() === head &&
    run.event === "push" && run.conclusion === "success" && run.path === ".github/workflows/ci.yml");
  if (!passed) throw new Error("the main release candidate has no successful push Check");
  // Upstream update PRs must keep their live preview proof, which only the PR-based manual release checks.
  const pulls = await json(fetcher, token, `${api}/commits/${head}/pulls`);
  if (!Array.isArray(pulls)) throw new Error("GitHub returned no pull request list for the main release candidate");
  if (pulls.some((pull: { head?: { ref?: unknown } }) => typeof pull.head?.ref === "string" && pull.head.ref.startsWith("release-updates/")))
    throw new Error("the main head is a release update; release it through Manual release with its pull request");
  return { head };
}

export function mainCandidateOutputLines(candidate: MainCandidate): string {
  if (!sha.test(candidate.head)) throw new Error("main candidate output contains invalid values");
  return `head=${candidate.head}\n`;
}

async function runMainCandidateCli(env = process.env): Promise<void> {
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (env.GITHUB_REF !== "refs/heads/main") throw new Error("manual main releases run only from main");
  const expected = env.MAIN_RELEASE_EXPECTED_HEAD;
  if (env.MAIN_RELEASE_REQUIRE_EXPECTED === "true" && !expected)
    throw new Error("the backed-up main head is missing; start a new release");
  const candidate = await validateMainCandidate(
    env.GITHUB_REPOSITORY ?? "",
    token,
    env.MAIN_RELEASE_CHECKOUT ?? "",
    expected || undefined,
  );
  const lines = mainCandidateOutputLines(candidate);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(candidate)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runMainCandidateCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
