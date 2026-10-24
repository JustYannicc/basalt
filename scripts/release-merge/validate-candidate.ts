import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GitHubApi } from "./github.ts";
import { validateReleaseCandidate } from "./candidate.ts";

export async function validatePullRequestEvent(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!repository || !eventPath) throw new Error("GitHub pull request event environment is incomplete");
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
    repository?: { full_name?: unknown };
    pull_request?: { number?: unknown; head?: { sha?: unknown } };
  };
  const number = event.pull_request?.number;
  const expectedHead = event.pull_request?.head?.sha;
  if (event.repository?.full_name !== repository || typeof number !== "number" || !Number.isSafeInteger(number) || typeof expectedHead !== "string")
    throw new Error("pull request event is missing a trusted repository, number, or head SHA");

  const result = await validateReleaseCandidate(new GitHubApi(), repository, number, expectedHead);
  if (!result.allowed) throw new Error(result.reasons.join("; "));
  process.stdout.write(`${JSON.stringify({ status: "candidate-allowed", pullRequest: number, head: result.headSha, base: result.currentMainSha })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await validatePullRequestEvent();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
