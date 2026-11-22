import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isCheckJob } from "./retry-history.ts";

// box-rerun.yml, after a Check completes: re-runs a run's jobs on GitHub's runners only when
// box-watch cancelled that run because the box took none of its box jobs, proven by a verdict for
// that run's first attempt whose stuck jobs really are box jobs of it that never got a runner. A
// re-run is a later attempt, which never routes and is never re-run here, so nothing loops.
// A Check a person cancelled has no verdict; one with a genuine failure stays as it is for a person
// to classify, and its stuck box jobs run on GitHub's runners when that person re-runs it.

export type Run = { id: number; attempt: number; conclusion: string | null };
export type RerunJob = {
  id: number;
  name: string;
  conclusion: string | null;
  labels?: readonly string[];
  runnerName?: string | null;
  startedAt?: string | null;
};
export type RerunDecision =
  | { action: "none"; why: string }
  | { action: "report"; why: string; stuck: number[]; failed: string[] }
  | { action: "rerun"; stuck: number[] };

const ids = (value: unknown) =>
  Array.isArray(value) && value.every((id) => Number.isSafeInteger(id) && id > 0)
    ? (value as number[])
    : undefined;

/** The verdict box-watch wrote, or undefined when the text is not one. */
export function parseVerdict(text: string | undefined) {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const stuck = ids(value.stuck);
    const cutOff = ids(value.cutOff);
    if (
      !Number.isSafeInteger(value.run) ||
      !Number.isSafeInteger(value.attempt) ||
      (value.reason !== "box-down" && value.reason !== "held-past-deadline") ||
      !stuck?.length ||
      !cutOff ||
      typeof value.at !== "string" ||
      !Number.isFinite(Date.parse(value.at))
    )
      return undefined;
    return {
      run: value.run as number,
      attempt: value.attempt as number,
      reason: value.reason,
      stuck,
      cutOff,
      at: Date.parse(value.at),
    };
  } catch {
    return undefined;
  }
}

export function rerunDecision(
  run: Run,
  verdictText: string | undefined,
  jobs: readonly RerunJob[],
  boxLabel: string,
  /** A newer Check runs for this pull request; re-running this one would cancel it. */
  superseded = false,
): RerunDecision {
  if (run.conclusion !== "cancelled") return { action: "none", why: "the run was not cancelled" };
  if (run.attempt !== 1) return { action: "none", why: "only a first attempt routes to the box" };
  const verdict = parseVerdict(verdictText);
  if (!verdict) return { action: "none", why: "box-watch did not cancel this run" };
  if (verdict.run !== run.id || verdict.attempt !== run.attempt)
    return { action: "none", why: "box-watch's verdict names another run or attempt" };
  // A forged verdict can't name jobs the box never held: each stuck job must be a box job of this
  // attempt that the cancel stopped before it got a runner, or that the box only took after the
  // verdict, in the seconds before the cancel landed.
  const label = boxLabel.toLowerCase();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const unheld = verdict.stuck.filter((id) => {
    const job = byId.get(id);
    const startedLate = !!job?.startedAt && Date.parse(job.startedAt) >= verdict.at;
    return !(
      job &&
      job.conclusion === "cancelled" &&
      (!job.runnerName || startedLate) &&
      (job.labels ?? []).some((value) => value.toLowerCase() === label)
    );
  });
  if (!label || unheld.length)
    return { action: "none", why: "box-watch's verdict names jobs the box never held" };
  if (superseded)
    return {
      action: "none",
      why: "a newer Check runs for this pull request, and a re-run would cancel it",
    };
  // The aggregate runs after any cancel and fails on the cancelled jobs; it is no real failure.
  // Nor is a box job's, when the box went down under it: its runner was lost, not its test.
  const lostBox = (job: RerunJob) =>
    verdict.reason === "box-down" &&
    (job.labels ?? []).some((value) => value.toLowerCase() === label);
  const failed = jobs
    .filter((job) => job.conclusion === "failure" && !isCheckJob(job.name) && !lostBox(job))
    .map((job) => job.name);
  if (failed.length)
    return {
      action: "report",
      why: "a job failed for real, so the run stays as it is for a person to classify",
      stuck: verdict.stuck,
      failed,
    };
  return { action: "rerun", stuck: verdict.stuck };
}

/** A GitHub call, tried three times: a 5xx or a dropped connection is common and passes. */
export async function retried(
  call: () => Promise<Response>,
  what: string,
  tries = 3,
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 1; ; attempt++) {
    const response = await call().catch((error: Error) => error);
    if (response instanceof Response && (response.ok || response.status < 500)) {
      if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${what}`);
      return response;
    }
    if (attempt === tries)
      throw new Error(
        `GitHub kept failing ${what}: ${response instanceof Response ? response.status : response.message}`,
      );
    await pause(2_000 * attempt);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const api = `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
  };
  const run: Run = {
    id: Number(env.RUN_ID),
    attempt: Number(env.RUN_ATTEMPT),
    conclusion: env.RUN_CONCLUSION ?? null,
  };
  const path = env.BOX_WATCH_VERDICT ?? "";
  const verdict = path && existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const jobs: RerunJob[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await retried(
      () =>
        fetch(
          `${api}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100&page=${page}`,
          { headers, signal: AbortSignal.timeout(20_000) },
        ),
      "the run's jobs",
    );
    const batch = ((await response.json()) as { jobs?: Record<string, unknown>[] }).jobs ?? [];
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
  // A pull request's Checks share one concurrency group that cancels in progress, so a re-run of a
  // superseded run would cancel the newest. Push runs each have their own group.
  let superseded = false;
  if (env.RUN_EVENT === "pull_request") {
    const branch = encodeURIComponent(env.HEAD_BRANCH ?? "");
    const response = await retried(
      () =>
        fetch(
          `${api}/actions/workflows/ci.yml/runs?event=pull_request&branch=${branch}&per_page=20`,
          { headers, signal: AbortSignal.timeout(20_000) },
        ),
      "the branch's Checks",
    );
    const runs =
      ((await response.json()) as { workflow_runs?: { id?: number }[] }).workflow_runs ?? [];
    superseded = runs.some((other) => Number(other.id) > run.id);
  }
  const decision = rerunDecision(run, verdict, jobs, env.BOX_LABEL ?? "", superseded);
  const say = (line: string) => {
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line + "\n");
  };
  if (decision.action === "none") say(`Box re-run: nothing to do, because ${decision.why}.`);
  else if (decision.action === "report")
    say(
      `Box re-run: not re-running, because ${decision.why} (${decision.failed.join(", ")}). ` +
        `Box jobs that never ran: ${decision.stuck.join(", ")}; they run on GitHub's runners when the run is re-run.`,
    );
  else {
    await retried(
      () =>
        fetch(`${api}/actions/runs/${run.id}/rerun-failed-jobs`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(20_000),
        }),
      "the re-run",
    );
    say(
      `Box re-run: re-running the jobs box-watch's cancel stopped, ${decision.stuck.length} of them box jobs that never started, on GitHub's runners.`,
    );
  }
}
