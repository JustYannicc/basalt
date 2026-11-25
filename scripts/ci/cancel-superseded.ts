import { fileURLToPath } from "node:url";
import { github, pullRequestRuns, say, type GitHub, type PullRequestRun } from "./workflow-run.ts";

// A pull request's full and affected-lane Checks have separate concurrency groups, so a full run
// a label asks for never waits behind the lane run of the same head. Each group cancels only its
// own older runs; this cancels the rest: any older unfinished run of an earlier head, and, from a
// full run, the lane run of its own head. A lane run leaves a full run of its own head alone.

export function supersededRuns(
  runs: readonly PullRequestRun[],
  current: { id: number; head: string; full: boolean; repository: string },
) {
  return runs
    .filter(
      (run) =>
        run.id < current.id &&
        run.status !== "completed" &&
        // A fork's pull request may share the branch name; only this repository's own runs count.
        run.head_repository?.full_name === current.repository &&
        (run.head_sha !== current.head || current.full),
    )
    .map((run) => run.id);
}

export async function cancelSuperseded(api: GitHub, env = process.env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_TOKEN) return [];
  if (env.HEAD_REPOSITORY !== env.GITHUB_REPOSITORY) return [];
  const stale = supersededRuns(await pullRequestRuns(api, env.HEAD_BRANCH ?? "", 50), {
    id: Number(env.GITHUB_RUN_ID),
    head: env.HEAD_SHA ?? "",
    full: env.FULL_SUITE === "true",
    repository: env.GITHUB_REPOSITORY ?? "",
  });
  for (const id of stale)
    // A run that finished in the meantime answers 409; it needs no cancel.
    await api
      .call(`/actions/runs/${id}/cancel`, { method: "POST" })
      .then(() => say(`Cancelled superseded Check run ${id}.`))
      .catch((error: Error) => say(`Could not cancel Check run ${id}: ${error.message}`));
  return stale;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  // Best effort: a failure here never fails selection; each group still cancels its own runs.
  await cancelSuperseded(github()).catch((error: Error) =>
    console.log(`::warning::Superseded Check runs were not cancelled: ${error.message}`),
  );
