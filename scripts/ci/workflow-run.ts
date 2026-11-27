import { appendFileSync } from "node:fs";

// What box-rerun.yml and flake-rerun.yml read from GitHub about the Check run that triggered them.

export type Run = {
  id: number;
  attempt: number;
  conclusion: string | null;
  /** The run's event and head branch, as workflow_run gives them. */
  event?: string;
  branch?: string;
};
export type RunJob = {
  id: number;
  name: string;
  conclusion: string | null;
  labels?: readonly string[];
  runnerName?: string | null;
  startedAt?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
};

/** A GitHub call, tried three times: a 5xx or a dropped connection is common and passes. */
export async function retried(
  call: () => Promise<Response>,
  what: string,
  tries = 3,
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  accept = (response: Response) => response.ok,
) {
  for (let attempt = 1; ; attempt++) {
    const response = await call().catch((error: Error) => error);
    if (response instanceof Response && (accept(response) || response.status < 500)) {
      if (!accept(response)) throw new Error(`GitHub returned ${response.status} for ${what}`);
      return response;
    }
    if (attempt === tries)
      throw new Error(
        `GitHub kept failing ${what}: ${response instanceof Response ? response.status : response.message}`,
      );
    await pause(2_000 * attempt);
  }
}

export function github(env = process.env) {
  const api = `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
  };
  // Only a caller that asked not to follow redirects takes one back.
  const call = (path: string, init: RequestInit = {}) =>
    retried(
      () => fetch(api + path, { headers, signal: AbortSignal.timeout(20_000), ...init }),
      path.split("?")[0]!,
      3,
      undefined,
      (response) => response.ok || (init.redirect === "manual" && response.status === 302),
    );
  const json = async <T>(path: string) => (await (await call(path)).json()) as T;
  return { call, json };
}
export type GitHub = ReturnType<typeof github>;

/** The run from the workflow_run event box-rerun.yml and flake-rerun.yml pass in. */
export const triggeringRun = (env = process.env): Run => ({
  id: Number(env.RUN_ID),
  attempt: Number(env.RUN_ATTEMPT),
  conclusion: env.RUN_CONCLUSION ?? null,
  event: env.RUN_EVENT,
  branch: env.HEAD_BRANCH,
});

export async function attemptJobs(api: GitHub, run: Run) {
  const jobs: RunJob[] = [];
  let total = 0;
  // Fifty a page, as the router reads them: GitHub answers 502 to a hundred for a re-run Check.
  for (let page = 1; page <= 20; page++) {
    const body = await api.json<{ total_count?: number; jobs?: Record<string, unknown>[] }>(
      `/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=50&page=${page}`,
    );
    total = Number(body.total_count ?? 0);
    const batch = body.jobs ?? [];
    for (const job of batch)
      jobs.push({
        id: Number(job.id),
        name: String(job.name),
        conclusion: (job.conclusion as string | null) ?? null,
        labels: Array.isArray(job.labels) ? job.labels.map(String) : [],
        runnerName: (job.runner_name as string | null) ?? null,
        startedAt: (job.started_at as string | null) ?? null,
        createdAt: (job.created_at as string | null) ?? null,
        completedAt: (job.completed_at as string | null) ?? null,
      });
    if (batch.length < 50) break;
  }
  // A decision over part of the run would miss its other failures.
  if (jobs.length < total) throw new Error(`read ${jobs.length} of the run's ${total} jobs`);
  return jobs;
}

export type PullRequestRun = {
  id: number;
  status: string;
  head_sha: string;
  head_repository?: { full_name?: string } | null;
};

/** The most recent Check runs for a pull request branch, newest first. */
export async function pullRequestRuns(api: GitHub, branch: string, count = 20) {
  const body = await api.json<{ workflow_runs?: PullRequestRun[] }>(
    `/actions/workflows/ci.yml/runs?event=pull_request&branch=${encodeURIComponent(branch)}&per_page=${count}`,
  );
  return body.workflow_runs ?? [];
}

/**
 * Whether a newer Check runs for this pull request's branch. A pull request's Checks of one lane
 * share a concurrency group that cancels in progress, so re-running a superseded one could cancel
 * the newest; push runs each have their own group.
 */
export async function supersededPullRequest(api: GitHub, run: Run, env = process.env) {
  if (env.RUN_EVENT !== "pull_request") return false;
  // A fork's pull request may share the branch name; only this repository's own runs count.
  return (await pullRequestRuns(api, env.HEAD_BRANCH ?? "")).some(
    (other) =>
      Number(other.id) > run.id && other.head_repository?.full_name === env.GITHUB_REPOSITORY,
  );
}

/** A job's whole log. GitHub answers with a signed link that must be fetched without the token. */
export async function jobLog(api: GitHub, id: number) {
  const response = await api.call(`/actions/jobs/${id}/logs`, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) return response.text();
  const log = await fetch(location, { signal: AbortSignal.timeout(60_000) });
  if (!log.ok) throw new Error(`the log of job ${id} returned ${log.status}`);
  return log.text();
}

/** Prints a line to the log and the step's summary. */
export const say = (line: string, env = process.env) => {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line + "\n");
};
