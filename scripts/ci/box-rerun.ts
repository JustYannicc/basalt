import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boxIsUp, githubObserver } from "./box-router.ts";
import { onLightRunners, queuedMinutes } from "./light-lane.ts";
import { isCheckJob } from "./retry-history.ts";
import {
  attemptJobs,
  github,
  say,
  supersededPullRequest,
  triggeringRun,
  type Run,
  type RunJob,
} from "./workflow-run.ts";

// box-rerun.yml, after a Check completes: re-runs a run's jobs on GitHub's runners only when
// box-watch cancelled that run because the box took none of its box jobs, proven by a verdict for
// that run's first attempt whose stuck jobs really are box jobs of it that never got a runner, or
// when a light job of it waited for the light runners and was cancelled before any took it, which
// is the state light-rescue.yml's cancel leaves. A re-run is a later attempt, which never routes and
// is never re-run here, so nothing loops. Any other cancelled Check has neither; one with a genuine
// failure stays as it is for a person to classify, and its stuck jobs run on GitHub's runners when
// that person re-runs it.

export type { Run };
export { retried } from "./workflow-run.ts";
export type RerunJob = RunJob;
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
  /** The box's heartbeat shows it up now; read only for a run with a light job held. */
  boxUp?: boolean,
): RerunDecision {
  if (run.conclusion !== "cancelled") return { action: "none", why: "the run was not cancelled" };
  if (run.attempt !== 1) return { action: "none", why: "only a first attempt routes to the box" };
  const verdict = parseVerdict(verdictText);
  // A verdict that doesn't hold for this run leaves the light path, which reads only the run's own
  // jobs, so a forged verdict gains nothing.
  const light = () => lightDecision(jobs, boxLabel, superseded, boxUp);
  if (!verdict || verdict.run !== run.id || verdict.attempt !== run.attempt) return light();
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
  if (!label || unheld.length) return light();
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

/**
 * The light jobs of a cancelled run that waited `queuedMinutes` for a light runner: cancelled before
 * any took one, or taken only after that wait, in the seconds before the cancel landed.
 */
export function lightHeld(jobs: readonly RerunJob[]) {
  const waited = (job: RerunJob) =>
    Date.parse((job.runnerName ? job.startedAt : job.completedAt) ?? "") -
      Date.parse(job.createdAt ?? "") >=
    queuedMinutes * 60_000;
  return jobs
    .filter((job) => job.conclusion === "cancelled" && onLightRunners(job.labels) && waited(job))
    .map((job) => job.id);
}

/**
 * A Check without box-watch's verdict is re-run when one of its light jobs waited for the light
 * runners and was cancelled while the box's heartbeat does not show it up: the state
 * light-rescue.yml's cancel leaves, whatever stopped that rescue afterwards. With the box up the
 * wait was a busy queue, and a person's cancel stands. A heartbeat that can't be read counts as not
 * up, so a rescued run is never left cancelled.
 */
function lightDecision(
  jobs: readonly RerunJob[],
  boxLabel: string,
  superseded: boolean,
  boxUp: boolean | undefined,
): RerunDecision {
  const stuck = lightHeld(jobs);
  if (!stuck.length)
    return {
      action: "none",
      why: "box-watch did not cancel this run, and no light job of it waited for a runner that never came",
    };
  if (boxUp)
    return {
      action: "none",
      why: "the box is up, so its light runners were only busy and the cancel was a person's",
    };
  if (superseded)
    return {
      action: "none",
      why: "a newer Check runs for this pull request, and a re-run would cancel it",
    };
  // The light runners sit on the box, so it was down: a light or box job that failed lost its
  // runner, not its test. The aggregate fails on any cancel.
  const label = boxLabel.toLowerCase();
  const lost = (job: RerunJob) =>
    onLightRunners(job.labels) ||
    (!!label && (job.labels ?? []).some((value) => value.toLowerCase() === label));
  const failed = jobs
    .filter((job) => job.conclusion === "failure" && !isCheckJob(job.name) && !lost(job))
    .map((job) => job.name);
  if (failed.length)
    return {
      action: "report",
      why: "a job failed for real, so the run stays as it is for a person to classify",
      stuck,
      failed,
    };
  return { action: "rerun", stuck };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const api = github(env);
  const run = triggeringRun(env);
  const path = env.BOX_WATCH_VERDICT ?? "";
  const verdict = path && existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const jobs = await attemptJobs(api, run);
  const superseded = await supersededPullRequest(api, run, env);
  // The box's state, read as light-rescue.yml reads it, only for a run with a light job held.
  const boxUp = lightHeld(jobs).length
    ? await githubObserver(
        {
          api: env.GITHUB_API_URL ?? "https://api.github.com",
          repository: env.GITHUB_REPOSITORY ?? "",
          token: env.GITHUB_TOKEN ?? "",
          runId: "",
          label: env.BOX_LABEL ?? "",
          heartbeatLabel: env.BOX_HEARTBEAT_LABEL ?? "",
        },
        fetch,
        Date.now,
      )
        .heartbeat()
        .then((heartbeat) => boxIsUp(heartbeat, Date.now()))
        .catch(() => false)
    : undefined;
  const decision = rerunDecision(run, verdict, jobs, env.BOX_LABEL ?? "", superseded, boxUp);
  if (decision.action === "none") say(`Box re-run: nothing to do, because ${decision.why}.`);
  else if (decision.action === "report")
    say(
      `Box re-run: not re-running, because ${decision.why} (${decision.failed.join(", ")}). ` +
        `Jobs that never got a runner: ${decision.stuck.join(", ")}; they run on GitHub's runners when the run is re-run.`,
    );
  else {
    await api.call(`/actions/runs/${run.id}/rerun-failed-jobs`, { method: "POST" });
    say(
      `Box re-run: re-running the jobs the cancel stopped, ${decision.stuck.length} of them jobs that never got a runner, on GitHub's runners.`,
    );
  }
}
