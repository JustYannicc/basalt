import { fileURLToPath } from "node:url";
import {
  boxIsUp,
  githubObserver,
  heartbeatBudget,
  heartbeatRunnerLabel,
  tokenReserve,
  TokenBudget,
  type Heartbeat,
} from "./box-router.ts";
import { say, supersededPullRequest, type GitHub } from "./workflow-run.ts";

// light-rescue.yml, every 5 minutes. A Check job queued for the light runners can't move to hosted
// runners, so while the box's heartbeat shows it down, each first attempt of this repository's own
// Check whose light job has waited 3 minutes is cancelled and its failed and cancelled jobs re-run:
// that is attempt 2, which runs every job hosted. A box that is up, or holding with no CI budget,
// keeps its light jobs, and no Check is listed. GitHub answering badly never counts as down.

/** How long a light job may wait queued before a down box counts as holding it. */
export const queuedMinutes = 3;
/** How often, and for how long, a cancelled run is read for its end before it is re-run. */
export const pollMs = 5_000;
export const pollLimitMs = 60_000;
/**
 * The most REST calls one rescue spends. Every Check shares the workflow token's hourly limit; an
 * up box costs about 3 (the heartbeat), a down one 2 more plus one or two per active Check, and
 * each rescued run at most `finishCalls`.
 */
export const maxCalls = 100;
/** A rescued run's calls: its cancel, every poll, its pull request's newer-Check read, its re-run. */
export const finishCalls = 1 + (pollLimitMs / pollMs + 1) + 2;
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

/** Why the box counts as down, or undefined while it is up or its state can't be read. */
async function boxDown(
  env: RescueEnv,
  api: Client,
  now: () => number,
  line: (text: string) => void,
) {
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
    return "no completed heartbeat run is from the box";
  }
  const at = now();
  const state = heartbeatBudget(heartbeat, at);
  // A box with no CI budget is holding, not down: the light runners sit outside that budget.
  if (!boxIsUp(heartbeat, at)) return String(state);
  line(
    `the box is up (${typeof state === "string" ? state : `a CI budget of ${state.budget}`}); its light runners take their own jobs.`,
  );
  return undefined;
}

/** This repository's first-attempt Checks with a light job queued `queuedMinutes` or more. */
async function heldChecks(env: RescueEnv, api: Client, label: string, at: number) {
  const listed = new Map<number, Json>();
  for (const status of ["in_progress", "queued"])
    for (let page = 1; ; page++) {
      const { workflow_runs: runs } = await api.json(
        `/actions/workflows/ci.yml/runs?status=${status}&per_page=100&page=${page}`,
      );
      if (!Array.isArray(runs)) throw new Error("GitHub listed no Check runs");
      for (const run of runs.map(record)) listed.set(Number(run.id), run);
      if (runs.length < 100) break;
      if (page === 10) throw new Error("more than 1,000 active Check runs");
    }
  const checks = [...listed.values()].filter(
    (run) =>
      String(run.path).split("@")[0] === checkPath &&
      Number(run.run_attempt) === 1 &&
      record(run.head_repository).full_name === env.repository,
  );
  const holds = (job: Json) =>
    job.status === "queued" &&
    Array.isArray(job.labels) &&
    job.labels.some((value) => String(value).toLowerCase() === label) &&
    at - Date.parse(String(job.created_at)) >= queuedMinutes * minute;
  const held: { run: Json; job: Json }[] = [];
  for (const run of checks)
    // Fifty a page, as the router reads a re-run Check's jobs: GitHub answers a hundred for one
    // with a 502, and this run may be re-run after it was listed. Attempt 1's are read either way.
    for (let page = 1; page <= 20; page++) {
      const { jobs } = await api.json(
        `/actions/runs/${Number(run.id)}/attempts/1/jobs?per_page=50&page=${page}`,
      );
      if (!Array.isArray(jobs)) throw new Error("GitHub listed no jobs");
      const job = jobs.map(record).find(holds);
      if (job) {
        held.push({ run, job });
        break;
      }
      if (jobs.length < 50) break;
    }
  return { checks: checks.length, held };
}

/** Rescues the Checks a down box holds; false when a held run was left cancelled or uncancelled. */
export async function rescue(
  env: RescueEnv,
  fetcher: Fetch = fetch,
  clock: Clock = realClock,
  print: (line: string) => void = say,
) {
  const line = (text: string) => print("Light rescue: " + text);
  const label = heartbeatRunnerLabel(env.lightLabel).toLowerCase();
  if (!label) {
    line("nothing to do: BASALT_CI_LIGHT_LABEL is empty or names a label other runners share.");
    return true;
  }
  const api = client(env, fetcher, clock);
  const down = await boxDown(env, api, clock.now, line);
  if (down === undefined) return true;
  const at = clock.now();
  let found: Awaited<ReturnType<typeof heldChecks>>;
  try {
    found = await heldChecks(env, api, label, at);
  } catch (error) {
    line(`the Checks could not be read (${(error as Error).message}); nothing is cancelled.`);
    return true;
  }
  line(
    `the box is down (${down}); ${found.held.length} of ${found.checks} first-attempt Checks have a light job queued ${queuedMinutes} minutes or more.`,
  );

  let finished = true;
  const cancelled = new Map<number, Json>();
  for (const { run, job } of found.held) {
    const id = Number(run.id);
    if (api.calls() + finishCalls * (cancelled.size + 1) > maxCalls) {
      line(`left run ${id} for the next rescue: finishing it would pass ${maxCalls} API calls.`);
      continue;
    }
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
    const waited = Math.floor((at - Date.parse(String(job.created_at))) / minute);
    line(
      `cancelled run ${id}: its ${String(job.name)} job waited ${waited} minutes for the light runners.`,
    );
    cancelled.set(id, run);
  }

  const github: GitHub = {
    call: (path, init) => api.call(path, init?.method, true),
    json: async <T>(path: string) => (await api.json(path, true)) as T,
  };
  const rerun = async (id: number, run: Json, ended: Json) => {
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
      return `left run ${id}: a newer Check runs for its pull request, and a re-run would cancel it.`;
    await api.call(`/actions/runs/${id}/rerun-failed-jobs`, "POST", true);
    return `re-ran run ${id}'s failed and cancelled jobs; attempt 2 runs them hosted.`;
  };
  // Each run is re-run as soon as it reports its end.
  const deadline = clock.now() + pollLimitMs;
  while (cancelled.size) {
    for (const [id, run] of cancelled) {
      const ended = await api.json(`/actions/runs/${id}`, true).catch(() => undefined);
      if (ended?.status !== "completed") continue;
      cancelled.delete(id);
      try {
        line(await rerun(id, run, ended));
      } catch (error) {
        line(
          `could not re-run run ${id} (${(error as Error).message}); re-run its failed jobs by hand.`,
        );
        finished = false;
      }
    }
    if (!cancelled.size || clock.now() >= deadline) break;
    await clock.wait(pollMs);
  }
  for (const id of cancelled.keys()) {
    line(
      `run ${id} did not end within ${pollLimitMs / 1000} s of its cancel; re-run its failed jobs by hand.`,
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
