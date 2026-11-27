import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onLightRunners, queuedMinutes } from "./light-lane.ts";
import { isCheckJob } from "./retry-history.ts";
import {
  attemptJobs,
  github,
  say,
  supersededPullRequest,
  triggeringRun,
  type GitHub,
  type Run,
  type RunJob,
} from "./workflow-run.ts";

// box-rerun.yml, after a Check completes: re-runs a run's jobs on GitHub's runners only when
// box-watch cancelled that run because the box took none of its box jobs, proven by a verdict for
// that run's first attempt whose stuck jobs really are box jobs of it that never got a runner, or
// when a light job of it waited for the light runners and was cancelled before any took it, which
// is the state light-rescue.yml's cancel leaves, or when main's push Check failed only on the light
// runners. A re-run is a later attempt, which never routes and is never re-run here, so nothing
// loops. Any other cancelled Check has neither; one with a genuine
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
  /** Who cancelled the run, from a held light job's annotation; read only for a run with one. */
  canceller?: string,
): RerunDecision {
  if (run.conclusion === "failure" && run.attempt === 1) return lightFailure(run, jobs);
  if (run.conclusion !== "cancelled") return { action: "none", why: "the run was not cancelled" };
  if (run.attempt !== 1) return { action: "none", why: "only a first attempt routes to the box" };
  const verdict = parseVerdict(verdictText);
  // A verdict that doesn't hold for this run leaves the light path, which reads only the run's own
  // jobs, so a forged verdict gains nothing.
  const light = () => lightDecision(jobs, superseded, canceller);
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
 * any took one, or taken in the seconds before the cancel landed. The rescue reads the job listing,
 * which lags, so a job a runner took counts from a minute before the wait.
 */
export function lightHeld(jobs: readonly RerunJob[]) {
  const waited = (job: RerunJob) =>
    Date.parse((job.runnerName ? job.startedAt : job.completedAt) ?? "") -
      Date.parse(job.createdAt ?? "") >=
    (queuedMinutes - (job.runnerName ? 1 : 0)) * 60_000;
  return jobs
    .filter((job) => job.conclusion === "cancelled" && onLightRunners(job.labels) && waited(job))
    .map((job) => job.id);
}

/**
 * A failed first attempt of main's push Check is re-run hosted when every job that failed or timed
 * out, the aggregate aside, ran on the light runners. The lane is main's alone, and a light runner that
 * breaks under a job (a tool it lacks, a lost connection) must not leave red the Check every release
 * waits on until someone looks. The aggregate fails whenever a need does, so its own failure
 * counts only when every need passed. A job anywhere else that didn't pass is a real failure: the
 * run stays red for a person. The re-run is attempt 2: it runs every re-run job hosted,
 * passes only if they pass there, and is never re-run here.
 */
function lightFailure(run: Run, jobs: readonly RerunJob[]): RerunDecision {
  if (run.event !== "push" || run.branch !== "main")
    return { action: "none", why: "only main's push Check uses the light runners" };
  const onLight = (job: RerunJob) => !!job.runnerName && onLightRunners(job.labels);
  // A light job past its timeout-minutes, or whose runner went away, ends cancelled after it took a
  // runner: on main's Check that is the light runner breaking too (a person's cancel ends the run
  // cancelled, which never comes here).
  const broke = (job: RerunJob) =>
    ["failure", "cancelled", "timed_out"].includes(job.conclusion ?? "");
  const needs = jobs.filter((job) => !isCheckJob(job.name) && broke(job));
  // With every need passed, an aggregate that failed on a light runner broke there.
  const aggregate = jobs.filter((job) => isCheckJob(job.name) && job.conclusion === "failure");
  const light = (needs.length ? needs : aggregate).filter(onLight);
  if (!light.length)
    return { action: "none", why: "no job failed or timed out on the light runners" };
  // rerun-failed-jobs re-runs cancelled jobs too, and a job past its timeout reads as cancelled:
  // any job off the light runners that didn't pass is a real failure, kept red for a person.
  const passed = ["success", "skipped", "neutral"];
  const elsewhere = jobs
    .filter(
      (job) => !isCheckJob(job.name) && !onLight(job) && !passed.includes(job.conclusion ?? ""),
    )
    .map((job) => `${job.name} (${job.conclusion ?? "no conclusion"})`);
  if (elsewhere.length)
    return {
      action: "report",
      why: "a job off the light runners did not pass, so the run stays as it is for a person to classify",
      stuck: light.map((job) => job.id),
      failed: elsewhere,
    };
  return { action: "rerun", stuck: light.map((job) => job.id) };
}

/** The workflow token's login, as GitHub names it in a cancel's annotation. */
const workflowToken = "github-actions[bot]";

/**
 * Who cancelled a run, from one of its jobs' annotations ("The run was canceled [forcefully] by
 * @login."), or undefined when none says.
 */
export function cancelledBy(annotations: unknown) {
  if (!Array.isArray(annotations)) return undefined;
  for (const item of annotations) {
    const message = String((item as { message?: unknown } | null)?.message ?? "");
    const login = /^The run was canceled (?:forcefully )?by @([\w-]+(?:\[bot\])?)\.?$/.exec(
      message,
    )?.[1];
    if (login) return login;
  }
  return undefined;
}

/**
 * A Check without box-watch's verdict is re-run when one of its light jobs waited for the light
 * runners and was cancelled, unless the cancel was a person's: the state light-rescue.yml's cancel
 * leaves, made with the workflow token, whatever stopped that rescue afterwards. The cancel's own
 * record decides, not the box's state when this runs, which can be minutes later. A cancel whose
 * author can't be read is re-run, so a rescued run is never left cancelled.
 */
function lightDecision(
  jobs: readonly RerunJob[],
  superseded: boolean,
  canceller: string | undefined,
): RerunDecision {
  const stuck = lightHeld(jobs);
  if (!stuck.length)
    return {
      action: "none",
      why: "box-watch did not cancel this run, and no light job of it waited for a runner that never came",
    };
  if (canceller && canceller !== workflowToken)
    return {
      action: "none",
      why: `@${canceller} cancelled it, not the light rescue, and that cancel stands`,
    };
  if (superseded)
    return {
      action: "none",
      why: "a newer Check runs for this pull request, and a re-run would cancel it",
    };
  // A light job that failed lost its runner with the lane, not its test. A box job's failure is
  // real here: the rescue no longer acts only on a down box, so only box-watch's box-down verdict
  // excuses one. The aggregate fails on any cancel.
  const lost = (job: RerunJob) => onLightRunners(job.labels);
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

/**
 * Who cancelled the run, read from the first held light job's annotations (a job's id is its
 * check run's), only for a run with one; undefined when it can't be read.
 */
export async function heldCanceller(api: GitHub, jobs: readonly RerunJob[]) {
  const [id] = lightHeld(jobs);
  if (id === undefined) return undefined;
  return api
    .json<unknown>(`/check-runs/${id}/annotations?per_page=50`)
    .then(cancelledBy)
    .catch(() => undefined);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const api = github(env);
  const run = triggeringRun(env);
  const path = env.BOX_WATCH_VERDICT ?? "";
  const verdict = path && existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const jobs = await attemptJobs(api, run);
  const superseded = await supersededPullRequest(api, run, env);
  const canceller = await heldCanceller(api, jobs);
  const decision = rerunDecision(run, verdict, jobs, env.BOX_LABEL ?? "", superseded, canceller);
  if (decision.action === "none") say(`Box re-run: nothing to do, because ${decision.why}.`);
  else if (decision.action === "report")
    say(
      `Box re-run: not re-running, because ${decision.why} (${decision.failed.join(", ")}). ` +
        (run.conclusion === "failure"
          ? `Jobs that failed or timed out on the light runners: ${decision.stuck.join(", ")}; they run on GitHub's runners when the run is re-run.`
          : `Jobs that never got a runner: ${decision.stuck.join(", ")}; they run on GitHub's runners when the run is re-run.`),
    );
  else {
    // The decision ran a queue and a runner start after the run ended, and flake-rerun.yml may have
    // re-run it meanwhile: re-read the run's own state right before the POST.
    const state = await api.json<{ run_attempt?: unknown; status?: unknown }>(
      `/actions/runs/${run.id}`,
    );
    if (Number(state.run_attempt) !== run.attempt || state.status !== "completed")
      say(
        `Box re-run: not re-running, because run ${run.id} is now at attempt ${String(state.run_attempt)}, ${String(state.status)}.`,
      );
    else {
      await api.call(`/actions/runs/${run.id}/rerun-failed-jobs`, { method: "POST" });
      say(
        run.conclusion === "failure"
          ? `Box re-run: re-running main's Check on GitHub's runners, because only jobs on the light runners failed or timed out (${decision.stuck.length}).`
          : `Box re-run: re-running the jobs the cancel stopped, ${decision.stuck.length} of them jobs that never got a runner, on GitHub's runners.`,
      );
    }
  }
}
