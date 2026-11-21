import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { boxIsUp, githubObserver } from "./box-router.ts";

// box-watch, in a Check that routed jobs to the box: once every box job has started it is done. A
// job queued for the box can't move to GitHub's runners, so if the box takes none in time, it
// writes a verdict and the run is cancelled; box-rerun.yml then re-runs the stuck jobs on GitHub.

/** A box job may wait this long while the box is down before box-watch gives up on it. */
export const downMinutes = 5;
/** A healthy box holding a waiting job may keep it this long past the Check's floor. */
export const holdingMinutes = 5;
const minute = 60_000;
const notStarted = new Set(["queued", "waiting", "pending", "requested"]);

export type WatchedJob = {
  id: number;
  name: string;
  status: string;
  createdAt: string;
  onBox: boolean;
};
export type Verdict = {
  run: number;
  attempt: number;
  reason: "box-down" | "held-past-floor";
  /** Box jobs that never started. */
  stuck: number[];
  /** Jobs still running when box-watch cancelled the run. */
  cutOff: number[];
  at: string;
};
export type WatchInput = {
  jobs: readonly WatchedJob[];
  boxUp: boolean;
  now: number;
  /** When select finished: the box held its waiting jobs from then. */
  selectedAt: number;
  floorMinutes: number;
  run: number;
  attempt: number;
  /** box-watch's own job, never cut off by its own cancel. */
  self?: string;
};

export function watchDecision(
  input: WatchInput,
): { action: "done" } | { action: "wait" } | { action: "cancel"; verdict: Verdict } {
  const stuck = input.jobs.filter((job) => job.onBox && notStarted.has(job.status));
  if (!stuck.length) return { action: "done" };
  const oldest = Math.min(...stuck.map((job) => Date.parse(job.createdAt)));
  const down = !input.boxUp && input.now - oldest >= downMinutes * minute;
  const held = input.now - input.selectedAt >= (input.floorMinutes + holdingMinutes) * minute;
  if (!down && !held) return { action: "wait" };
  return {
    action: "cancel",
    verdict: {
      run: input.run,
      attempt: input.attempt,
      reason: down ? "box-down" : "held-past-floor",
      stuck: stuck.map((job) => job.id),
      cutOff: input.jobs
        .filter((job) => job.status === "in_progress" && job.name !== input.self)
        .map((job) => job.id),
      at: new Date(input.now).toISOString(),
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  const repository = env.GITHUB_REPOSITORY ?? "";
  const token = env.GITHUB_TOKEN ?? "";
  const run = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  const label = (env.BOX_LABEL ?? "").toLowerCase();
  const floorMinutes = Number(env.BOX_FLOOR ?? "0");
  const verdictPath = env.BOX_WATCH_VERDICT ?? "";
  if (!run || !attempt || !label || !verdictPath || !(floorMinutes >= 0))
    throw new Error("box-watch needs its run, attempt, box label, floor and verdict path");
  const observer = githubObserver({
    api,
    repository,
    token,
    runId: String(run),
    label,
    heartbeatLabel: env.BOX_HEARTBEAT_LABEL ?? "",
  });
  const jobsOf = async () => {
    const jobs: Record<string, unknown>[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await fetch(
        `${api}/repos/${repository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
        {
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) throw new Error(`GitHub returned ${response.status} for this run's jobs`);
      const batch = ((await response.json()) as { jobs?: Record<string, unknown>[] }).jobs ?? [];
      jobs.push(...batch);
      if (batch.length < 100) return jobs;
    }
    return jobs;
  };
  for (;;) {
    const jobs = await jobsOf();
    const select = jobs.find((job) => job.name === "select");
    const selectedAt = Date.parse(String(select?.completed_at ?? ""));
    let boxUp = false;
    try {
      boxUp = boxIsUp(await observer.heartbeat(), Date.now());
    } catch {}
    const decision = watchDecision({
      jobs: jobs.map((job) => ({
        id: Number(job.id),
        name: String(job.name),
        status: String(job.status),
        createdAt: String(job.created_at),
        onBox:
          Array.isArray(job.labels) &&
          job.labels.some((value) => String(value).toLowerCase() === label),
      })),
      boxUp,
      now: Date.now(),
      selectedAt: Number.isFinite(selectedAt) ? selectedAt : Date.now(),
      floorMinutes,
      run,
      attempt,
      self: "box-watch",
    });
    if (decision.action === "done") {
      console.log("Every box job of this Check has started.");
      break;
    }
    if (decision.action === "cancel") {
      const { verdict } = decision;
      mkdirSync(dirname(verdictPath), { recursive: true });
      writeFileSync(verdictPath, JSON.stringify(verdict));
      const why =
        verdict.reason === "box-down"
          ? `the box has not taken them for ${downMinutes} minutes and reports no healthy heartbeat`
          : `the box still held them ${holdingMinutes} minutes past the Check's ${floorMinutes}-minute floor`;
      const line = `box-watch: ${verdict.stuck.length} box jobs never started, because ${why}; cancelling this run so box-rerun.yml runs them on GitHub's runners.`;
      console.log(line);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line + "\n");
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "cancel=true\n");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}
