import { fileURLToPath } from "node:url";
import {
  boxIsUp,
  githubObserver,
  heartbeatBudget,
  tokenReserve,
  TokenBudget,
  type Heartbeat,
} from "./box-router.ts";
import { lightSuffix, usableLightLabel } from "./light-lane.ts";
import { isCheckJob } from "./retry-history.ts";
import { say, supersededPullRequest, type GitHub } from "./workflow-run.ts";

// light-rescue.yml, every 5 minutes. A Check job queued for the light runners can't move to hosted
// runners, so while the box's heartbeat shows it down, each first attempt of this repository's own
// Check whose light job has waited 3 minutes is cancelled. A cancelled first attempt whose light job
// waited that long and never got a runner is re-run once it ends, its failed and cancelled jobs:
// that is attempt 2, which runs every job hosted. The re-run looks at the state, not at who
// cancelled, so a run an earlier rescue cancelled but could not re-run is found again, and so is a
// held Check a person cancelled, which is re-run as the rescue would have. It looks while the box is
// down, and while it is up only after a rescue that did not finish. A run with a job that failed for
// real, or that a newer Check of its pull request supersedes, stays cancelled. A box that is up, or
// holding with no CI budget, keeps its light jobs. GitHub answering badly never counts as down.

/** How long a light job may wait queued before a down box counts as holding it. */
export const queuedMinutes = 3;
/** How long after its cancel a cancelled Check is still looked at for its re-run. */
export const cancelledHours = 2;
/** How often, and for how long, a cancelled run is read for its end before it is re-run. */
export const pollMs = 5_000;
export const pollLimitMs = 60_000;
/**
 * The most REST calls one rescue spends. Every Check shares the workflow token's hourly limit; an
 * up box costs 4 (the last rescue and the heartbeat), a down one 3 more plus one or two per active
 * or recently cancelled first attempt, and each rescued run at most `finishCalls`.
 */
export const maxCalls = 100;
/**
 * A rescued run's calls: its cancel, every poll, its jobs (a Check's fill two pages), its pull
 * request's newer-Check read and its re-run.
 */
export const finishCalls = 1 + (pollLimitMs / pollMs + 1) + 2 + 1 + 1;
const minute = 60_000;
const checkPath = ".github/workflows/ci.yml";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
export type RescueEnv = {
  api: string;
  repository: string;
  token: string;
  /** BASALT_CI_LIGHT_LABEL. */
  lightLabel: string;
  /** The labels the box's heartbeat runs on, as select reads them. */
  boxLabel: string;
  heartbeatLabel?: string;
};
export type Clock = { now(): number; wait(ms: number): Promise<unknown> };
const realClock: Clock = {
  now: Date.now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

/** REST calls under the rescue's cap and the token's reserve, retried on a 5xx. */
function client(env: RescueEnv, fetcher: Fetch, clock: Clock) {
  let calls = 0;
  let remaining = Number.POSITIVE_INFINITY;
  let unanswered = false;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: "Bearer " + env.token,
    "x-github-api-version": "2022-11-28",
  };
  // The calls that finish a run already cancelled skip the cap and the reserve: a cancelled run
  // left without its re-run is worse than a few calls over.
  const send: (url: string, init: RequestInit, finishing?: boolean) => Promise<Response> = async (
    url,
    init,
    finishing = false,
  ) => {
    if (!finishing && calls >= maxCalls)
      throw new TokenBudget(`the rescue would take more than ${maxCalls} API calls`);
    if (!finishing && remaining < tokenReserve)
      throw new TokenBudget(
        `the workflow token has ${remaining} of its hourly API calls left, and the rescue leaves ${tokenReserve} for the Checks`,
      );
    calls++;
    const response = await fetcher(url, init).catch((error: Error) => {
      unanswered = true;
      throw error;
    });
    const left = Number(response.headers.get("x-ratelimit-remaining") ?? Number.NaN);
    if (Number.isFinite(left)) remaining = Math.min(remaining, left);
    if (!response.ok) unanswered = true;
    return response;
  };
  const call = async (path: string, method = "GET", finishing = false) => {
    const what = `${method} ${path.split("?")[0]}`;
    for (let attempt = 1; ; attempt++) {
      const response = await send(
        env.api + "/repos/" + env.repository + path,
        { method, headers, signal: AbortSignal.timeout(20_000) },
        finishing,
      ).catch((error: Error) => error);
      if (response instanceof TokenBudget) throw response;
      if (response instanceof Response && response.status < 500) {
        if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${what}`);
        return response;
      }
      if (attempt === 3)
        throw new Error(
          `GitHub kept failing ${what}: ${response instanceof Response ? response.status : response.message}`,
        );
      await clock.wait(2_000 * attempt);
    }
  };
  const json = async (path: string, finishing = false) =>
    record(await (await call(path, "GET", finishing)).json());
  return {
    send,
    call,
    json,
    calls: () => calls,
    /** Whether any read so far failed or answered other than 2xx. */
    unanswered: () => unanswered,
  };
}
type Client = ReturnType<typeof client>;

/** Whether the box is down and why, or undefined when its state can't be read. */
async function boxState(
  env: RescueEnv,
  api: Client,
  now: () => number,
  line: (text: string) => void,
): Promise<{ down: string } | { up: string } | undefined> {
  let heartbeat: Heartbeat | undefined;
  try {
    heartbeat = await githubObserver(
      {
        api: env.api,
        repository: env.repository,
        token: env.token,
        runId: "",
        label: env.boxLabel,
        heartbeatLabel: env.heartbeatLabel ?? "",
      },
      (url, init) => api.send(url, init),
      now,
    ).heartbeat();
  } catch (error) {
    if (error instanceof TokenBudget || api.unanswered()) {
      line(
        `the box's heartbeat could not be read (${(error as Error).message}); nothing is cancelled.`,
      );
      return undefined;
    }
    // GitHub answered every read, and none was a heartbeat from the box.
    return { down: "no completed heartbeat run is from the box" };
  }
  const at = now();
  const state = heartbeatBudget(heartbeat, at);
  // A box with no CI budget is holding, not down: the light runners sit outside that budget.
  if (!boxIsUp(heartbeat, at)) return { down: String(state) };
  return { up: typeof state === "string" ? state : `a CI budget of ${state.budget}` };
}

/** Whether the rescue before this one ended in anything but success; unreadable counts as yes. */
async function lastRescueFailed(api: Client) {
  try {
    const { workflow_runs: runs } = await api.json(
      "/actions/workflows/light-rescue.yml/runs?status=completed&per_page=1",
    );
    if (!Array.isArray(runs)) return true;
    const last = record(runs[0]);
    return (
      last.conclusion !== undefined && !["success", "skipped"].includes(String(last.conclusion))
    );
  } catch {
    return true;
  }
}

/** This repository's own first-attempt Checks among the runs listed with `status`. */
async function firstAttempts(env: RescueEnv, api: Client, status: string, pages: number) {
  const listed: Json[] = [];
  for (let page = 1; page <= pages; page++) {
    const { workflow_runs: runs } = await api.json(
      `/actions/workflows/ci.yml/runs?status=${status}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(runs)) throw new Error("GitHub listed no Check runs");
    listed.push(...runs.map(record));
    if (runs.length < 100) break;
    if (page === pages && pages > 1)
      throw new Error(`more than ${pages * 100} ${status} Check runs`);
  }
  return listed.filter(
    (run) =>
      String(run.path).split("@")[0] === checkPath &&
      Number(run.run_attempt) === 1 &&
      record(run.head_repository).full_name === env.repository,
  );
}

/** Every job of a run's first attempt; a decision over part of the run would miss the rest. */
async function firstAttemptJobs(api: Client, id: number, finishing = false) {
  const jobs: Json[] = [];
  // Fifty a page, as the router reads a re-run Check's jobs: GitHub answers a hundred for one
  // with a 502, and this run may be re-run after it was listed.
  for (let page = 1; page <= 20; page++) {
    const body = await api.json(
      `/actions/runs/${id}/attempts/1/jobs?per_page=50&page=${page}`,
      finishing,
    );
    if (!Array.isArray(body.jobs)) throw new Error("GitHub listed no jobs");
    jobs.push(...body.jobs.map(record));
    if (body.jobs.length < 50) {
      if (jobs.length < Number(body.total_count ?? 0))
        throw new Error(`read ${jobs.length} of run ${id}'s ${String(body.total_count)} jobs`);
      return jobs;
    }
  }
  throw new Error(`run ${id} lists more than 1,000 jobs`);
}

const labelled = (job: Json, label: string) =>
  !!label &&
  Array.isArray(job.labels) &&
  job.labels.some((value) => String(value).toLowerCase() === label);
const waited = (job: Json, until: number) =>
  until - Date.parse(String(job.created_at)) >= queuedMinutes * minute;

/** Rescues the Checks a down box holds; false when a held run was left cancelled or uncancelled. */
export async function rescue(
  env: RescueEnv,
  fetcher: Fetch = fetch,
  clock: Clock = realClock,
  print: (line: string) => void = say,
) {
  const line = (text: string) => print("Light rescue: " + text);
  const label = usableLightLabel(env.lightLabel).toLowerCase();
  if (!label) {
    line(
      `nothing to do: BASALT_CI_LIGHT_LABEL is empty or no plain label ending in ${lightSuffix}, so every job runs hosted.`,
    );
    return true;
  }
  const api = client(env, fetcher, clock);
  const lastFailed = await lastRescueFailed(api);
  // Whatever this rescue can't read, it fails when the last one did, so the run that one may have
  // left cancelled is looked for again.
  const unread = () => !lastFailed;
  const box = await boxState(env, api, clock.now, line);
  if (box === undefined) return unread();
  if ("up" in box && !lastFailed) {
    line(`the box is up (${box.up}); its light runners take their own jobs.`);
    return true;
  }
  const at = clock.now();
  const boxLabel = env.boxLabel.toLowerCase();
  const held: { run: Json; job: Json }[] = [];
  const stranded: { run: Json; jobs: Json[] }[] = [];
  let checks = 0;
  try {
    if ("down" in box) {
      const active = [
        ...(await firstAttempts(env, api, "in_progress", 10)),
        ...(await firstAttempts(env, api, "queued", 10)),
      ];
      checks = new Set(active.map((run) => Number(run.id))).size;
      for (const run of new Map(active.map((run) => [Number(run.id), run])).values()) {
        const job = (await firstAttemptJobs(api, Number(run.id))).find(
          (candidate) =>
            candidate.status === "queued" && labelled(candidate, label) && waited(candidate, at),
        );
        if (job) held.push({ run, job });
      }
    }
    for (const run of await firstAttempts(env, api, "cancelled", 1)) {
      if (at - Date.parse(String(run.updated_at)) > cancelledHours * 60 * minute) continue;
      const jobs = await firstAttemptJobs(api, Number(run.id));
      // A light job cancelled after the rescue's wait, before any runner took it.
      if (
        jobs.some(
          (job) =>
            job.conclusion === "cancelled" &&
            !job.runner_name &&
            labelled(job, label) &&
            waited(job, Date.parse(String(job.completed_at))),
        )
      )
        stranded.push({ run, jobs });
    }
  } catch (error) {
    line(`the Checks could not be read (${(error as Error).message}); nothing is cancelled.`);
    return unread();
  }
  line(
    "down" in box
      ? `the box is down (${box.down}); ${held.length} of ${checks} first-attempt Checks have a light job queued ${queuedMinutes} minutes or more, and ${stranded.length} cancelled ones wait for their re-run.`
      : `the box is up (${box.up}), but the last rescue did not finish; ${stranded.length} cancelled first-attempt Checks wait for their re-run.`,
  );

  let finished = true;
  const pending = new Map<number, { run: Json; jobs?: Json[] }>();
  // A held run left uncancelled waits for the next rescue while the box is down, or for the light
  // runners once it is up; a cancelled one left behind needs the next rescue to look again.
  const room = (id: number, cancelled: boolean) => {
    if (api.calls() + finishCalls * (pending.size + 1) <= maxCalls) return true;
    line(`left run ${id} for the next rescue: finishing it would pass ${maxCalls} API calls.`);
    if (cancelled) finished = false;
    return false;
  };
  for (const { run, jobs } of stranded)
    if (room(Number(run.id), true)) pending.set(Number(run.id), { run, jobs });
  for (const { run, job } of held) {
    const id = Number(run.id);
    if (!room(id, false)) continue;
    // A plain cancel still starts the aggregate, which runs on always(): one already queued for
    // the light runners would wait there, and a run that never ends can't be re-run.
    try {
      await api.call(`/actions/runs/${id}/force-cancel`, "POST");
    } catch (error) {
      if (error instanceof TokenBudget) {
        line(`left run ${id} for the next rescue: ${error.message}.`);
        continue;
      }
      line(`could not cancel run ${id} (${(error as Error).message}).`);
      finished = false;
      continue;
    }
    const minutes = Math.floor((at - Date.parse(String(job.created_at))) / minute);
    line(
      `cancelled run ${id}: its ${String(job.name)} job waited ${minutes} minutes for the light runners.`,
    );
    pending.set(id, { run });
  }

  const github: GitHub = {
    call: (path, init) => api.call(path, init?.method, true),
    json: async <T>(path: string) => (await api.json(path, true)) as T,
  };
  const rerun = async (id: number, run: Json, ended: Json, known?: Json[]) => {
    if (Number(ended.run_attempt) !== 1) return `left run ${id}: something else re-ran it already.`;
    if (ended.conclusion === "success")
      return `left run ${id}: it passed before the cancel landed.`;
    const newer = await supersededPullRequest(
      github,
      { id, attempt: 1, conclusion: String(ended.conclusion) },
      {
        RUN_EVENT: String(run.event),
        HEAD_BRANCH: String(run.head_branch),
        GITHUB_REPOSITORY: env.repository,
      },
    );
    if (newer)
      return `left run ${id} cancelled: a newer Check runs for its pull request, and a re-run would cancel it.`;
    // The aggregate fails on any cancel, and while the box is down a box or light job that failed
    // lost its runner, not its test. Any other failure is a person's to classify.
    const lost = (job: Json) => "down" in box && (labelled(job, label) || labelled(job, boxLabel));
    const failed = (known ?? (await firstAttemptJobs(api, id, true)))
      .filter((job) => job.conclusion === "failure" && !isCheckJob(String(job.name)) && !lost(job))
      .map((job) => String(job.name));
    if (failed.length)
      return `left run ${id} cancelled for a person to classify: ${failed.join(", ")} failed for real.`;
    await api.call(`/actions/runs/${id}/rerun-failed-jobs`, "POST", true);
    return `re-ran run ${id}'s failed and cancelled jobs; attempt 2 runs them hosted.`;
  };
  // Each run is re-run as soon as it reports its end.
  const deadline = clock.now() + pollLimitMs;
  while (pending.size) {
    for (const [id, { run, jobs }] of pending) {
      const ended = await api.json(`/actions/runs/${id}`, true).catch(() => undefined);
      if (ended?.status !== "completed") continue;
      pending.delete(id);
      try {
        line(await rerun(id, run, ended, jobs));
      } catch (error) {
        line(
          `could not re-run run ${id} (${(error as Error).message}); the next rescue looks for it again.`,
        );
        finished = false;
      }
    }
    if (!pending.size || clock.now() >= deadline) break;
    await clock.wait(pollMs);
  }
  for (const id of pending.keys()) {
    line(
      `run ${id} did not end within ${pollLimitMs / 1000} s of its cancel; the next rescue looks for it again.`,
    );
    finished = false;
  }
  return finished;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const finished = await rescue({
    api: env.GITHUB_API_URL ?? "https://api.github.com",
    repository: env.GITHUB_REPOSITORY ?? "",
    token: env.GITHUB_TOKEN ?? "",
    lightLabel: env.LIGHT_LABEL ?? "",
    boxLabel: env.BOX_LABEL ?? "",
    heartbeatLabel: env.BOX_HEARTBEAT_LABEL ?? "",
  });
  if (!finished) process.exitCode = 1;
}
