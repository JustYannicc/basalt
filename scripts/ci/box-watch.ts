import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { boxIsUp, githubObserver, waveSlowdown } from "./box-router.ts";

// box-watch, in a Check's first attempt that routed jobs to the box: once every box job select
// named has started, it is done. A job queued for the box can't move to GitHub's runners, so if the
// box is down, or holds a job past the latest start that still ends by the Check's floor, it writes
// a verdict and the run is cancelled; box-rerun.yml then re-runs the stuck jobs on GitHub's runners.
// It fails open: when GitHub can't be read it never cancels.

/** The box may show no healthy heartbeat this long, after box-watch's own probe, before it is down. */
export const downMinutes = 5;
/** Margin past a job's latest start that still ends by the floor. */
export const holdingMinutes = 5;
/** box-watch gives up quietly after this long, inside its job's 45-minute timeout. */
export const watchMinutes = 40;
const minute = 60_000;
const notStarted = new Set(["queued", "waiting", "pending", "requested"]);

export type WatchedJob = {
  id: number;
  name: string;
  status: string;
  onBox: boolean;
};
export type Verdict = {
  run: number;
  attempt: number;
  reason: "box-down" | "held-past-deadline";
  /** Box jobs that never started. */
  stuck: number[];
  /** Jobs still running when box-watch cancelled the run. */
  cutOff: number[];
  at: string;
};
export type Planned = { minutes: number; wave: 1 | 2 };
export type WatchInput = {
  jobs: readonly WatchedJob[];
  /** The box jobs select named, by job name, with their planned hosted minutes and wave. */
  planned: Readonly<Record<string, Planned>>;
  /** Minutes the box has shown no healthy heartbeat since box-watch's own probe, or 0. */
  downFor: number;
  now: number;
  /** When select finished. */
  selectedAt: number;
  floorMinutes: number;
  run: number;
  attempt: number;
  /** box-watch's own job, never cut off by its own cancel. */
  self?: string;
};

/**
 * The minute after select by which a box job must have started: a first-wave job starts at once and
 * may wait until the floor plus the margin; a waiting one only as long as it still ends by the
 * floor at the keep rule's pace, plus the margin.
 */
export const latestStart = ({ minutes, wave }: Planned, floorMinutes: number) =>
  wave === 1
    ? floorMinutes + holdingMinutes
    : floorMinutes - minutes * waveSlowdown + holdingMinutes;

/** The job name GitHub shows for a box_jobs id: a declared shard's own, a leg as `job (leg)`. */
export const jobName = (id: string) => {
  const [job, leg] = id.split(":");
  return leg === undefined ? job! : `${job} (${leg})`;
};

export function watchDecision(
  input: WatchInput,
): { action: "done" } | { action: "wait" } | { action: "cancel"; verdict: Verdict } {
  const listed = new Map(input.jobs.map((job) => [job.name, job]));
  const names = Object.keys(input.planned);
  // A box job not listed yet still waits for its own needs; box-watch waits for it too.
  const missing = names.filter((name) => !listed.has(name));
  const stuck = names
    .map((name) => listed.get(name))
    .filter((job): job is WatchedJob => !!job && job.onBox && notStarted.has(job.status));
  if (!missing.length && !stuck.length) return { action: "done" };
  const elapsed = (input.now - input.selectedAt) / minute;
  const late = stuck.filter(
    (job) => !(elapsed < latestStart(input.planned[job.name]!, input.floorMinutes)),
  );
  const down = stuck.length > 0 && input.downFor >= downMinutes;
  if (!down && !late.length) return { action: "wait" };
  return {
    action: "cancel",
    verdict: {
      run: input.run,
      attempt: input.attempt,
      reason: down ? "box-down" : "held-past-deadline",
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
  const api = `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
  const token = env.GITHUB_TOKEN ?? "";
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}` };
  const run = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  const label = (env.BOX_LABEL ?? "").toLowerCase();
  const floorMinutes = Number(env.BOX_FLOOR ?? "0");
  const verdictPath = env.BOX_WATCH_VERDICT ?? "";
  const plan = JSON.parse(env.BOX_PLAN ?? "{}") as Record<string, Planned>;
  const planned = Object.fromEntries(Object.entries(plan).map(([id, job]) => [jobName(id), job]));
  if (!run || !attempt || !label || !verdictPath || !Object.keys(planned).length)
    throw new Error("box-watch needs its run, attempt, box label, plan and verdict path");
  const observer = githubObserver({
    api: env.GITHUB_API_URL ?? "https://api.github.com",
    repository: env.GITHUB_REPOSITORY ?? "",
    token,
    runId: String(run),
    label,
    heartbeatLabel: env.BOX_HEARTBEAT_LABEL ?? "",
  });
  const get = async (path: string) => {
    const response = await fetch(api + path, { headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok)
      throw new Error(`GitHub returned ${response.status} for ${path.split("?")[0]}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const jobsOf = async () => {
    const jobs: Record<string, unknown>[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await get(
        `/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      );
      const batch = Array.isArray(body.jobs) ? (body.jobs as Record<string, unknown>[]) : [];
      jobs.push(...batch);
      if (batch.length < 100) break;
    }
    return jobs;
  };
  const started = Date.now();
  let failingSince: number | undefined;
  let notUpSince: number | undefined;
  let probedAt = 0;
  const say = (line: string) => {
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line + "\n");
  };
  for (;;) {
    if (Date.now() - started >= watchMinutes * minute) {
      say(`box-watch: still waiting after ${watchMinutes} minutes; leaving the run as it is.`);
      break;
    }
    let decision: ReturnType<typeof watchDecision>;
    try {
      const jobs = await jobsOf();
      const selectedAt = Date.parse(
        String(jobs.find((job) => job.name === "select")?.completed_at ?? ""),
      );
      const watched = jobs.map((job) => ({
        id: Number(job.id),
        name: String(job.name),
        status: String(job.status),
        onBox:
          Array.isArray(job.labels) &&
          job.labels.some((value) => String(value).toLowerCase() === label),
      }));
      const stuck = watched.some(
        (job) => job.name in planned && job.onBox && notStarted.has(job.status),
      );
      // The box's health is read only while one of its jobs waits. A stale heartbeat may only mean
      // no Check started lately, so box-watch dispatches its own and counts the box down only when
      // that probe brings back no healthy heartbeat; one it can't read is unknown, never down.
      if (!stuck) notUpSince = undefined;
      else {
        let up: boolean | undefined;
        try {
          up = boxIsUp(await observer.heartbeat(), Date.now());
        } catch {}
        if (up === true) notUpSince = undefined;
        else if (up === false) {
          if (Date.now() - probedAt >= 2 * minute) {
            probedAt = Date.now();
            await fetch(`${api}/actions/workflows/box-heartbeat.yml/dispatches`, {
              method: "POST",
              headers,
              body: JSON.stringify({ ref: "main" }),
              signal: AbortSignal.timeout(20_000),
            }).catch(() => undefined);
          }
          notUpSince ??= probedAt;
        }
      }
      decision = watchDecision({
        jobs: watched,
        planned,
        downFor: notUpSince === undefined ? 0 : (Date.now() - notUpSince) / minute,
        now: Date.now(),
        selectedAt: Number.isFinite(selectedAt) ? selectedAt : started,
        floorMinutes,
        run,
        attempt,
        self: "box-watch",
      });
      failingSince = undefined;
    } catch (error) {
      // GitHub answering badly is no reason to cancel anything: retry, then give up quietly.
      failingSince ??= Date.now();
      if (Date.now() - failingSince >= 10 * minute) {
        say(`box-watch: GitHub could not be read for 10 minutes (${(error as Error).message}).`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      continue;
    }
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
          ? `the box has shown no healthy heartbeat for ${downMinutes} minutes, even after box-watch dispatched one`
          : "the box still held one past the latest start that ends by the Check's floor";
      say(
        `box-watch: ${verdict.stuck.length} box jobs never started, because ${why}; cancelling this run so box-rerun.yml runs them on GitHub's runners.`,
      );
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "cancel=true\n");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}
