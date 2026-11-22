import { appendFileSync } from "node:fs";

// What box-rerun.yml and flake-rerun.yml read from GitHub about the Check run that triggered them.

export type Run = { id: number; attempt: number; conclusion: string | null };
export type RunJob = {
  id: number;
  name: string;
  conclusion: string | null;
  labels?: readonly string[];
  runnerName?: string | null;
  startedAt?: string | null;
};

export function github(env = process.env) {
  const api = `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
  };
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(api + path, {
      headers,
      signal: AbortSignal.timeout(20_000),
      ...init,
    });
    if (!response.ok && response.status !== 302)
      throw new Error(`GitHub returned ${response.status} for ${path.split("?")[0]}`);
    return response;
  };
  const json = async <T>(path: string) => (await (await call(path)).json()) as T;
  return { call, json };
}
export type GitHub = ReturnType<typeof github>;

/** The run from the workflow_run event box-rerun.yml and flake-rerun.yml pass in. */
export const triggeringRun = (env = process.env): Run => ({
  id: Number(env.RUN_ID),
  attempt: Number(env.RUN_ATTEMPT),
  conclusion: env.RUN_CONCLUSION ?? null,
});

export async function attemptJobs(api: GitHub, run: Run) {
  const jobs: RunJob[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await api.json<{ jobs?: Record<string, unknown>[] }>(
      `/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100&page=${page}`,
    );
    const batch = body.jobs ?? [];
    for (const job of batch)
      jobs.push({
        id: Number(job.id),
        name: String(job.name),
        conclusion: (job.conclusion as string | null) ?? null,
        labels: Array.isArray(job.labels) ? job.labels.map(String) : [],
        runnerName: (job.runner_name as string | null) ?? null,
        startedAt: (job.started_at as string | null) ?? null,
      });
    if (batch.length < 100) break;
  }
  return jobs;
}

/**
 * Whether a newer Check runs for this pull request's branch. A pull request's Checks share one
 * concurrency group that cancels in progress, so re-running a superseded one would cancel the
 * newest; push runs each have their own group.
 */
export async function supersededPullRequest(api: GitHub, run: Run, env = process.env) {
  if (env.RUN_EVENT !== "pull_request") return false;
  const branch = encodeURIComponent(env.HEAD_BRANCH ?? "");
  const body = await api.json<{ workflow_runs?: { id?: number }[] }>(
    `/actions/workflows/ci.yml/runs?event=pull_request&branch=${branch}&per_page=20`,
  );
  return (body.workflow_runs ?? []).some((other) => Number(other.id) > run.id);
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
