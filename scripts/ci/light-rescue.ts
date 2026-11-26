import { fileURLToPath } from "node:url";
import {
  boxIsUp,
  githubObserver,
  heartbeatBudget,
  tokenReserve,
  TokenBudget,
  type Heartbeat,
} from "./box-router.ts";
import { onLightRunners, queuedMinutes } from "./light-lane.ts";
import { say } from "./workflow-run.ts";

// light-rescue.yml, every 5 minutes. A Check job queued for the light runners can't move to hosted
// runners, so while the box's heartbeat shows it down, each first attempt of this repository's own
// Check whose light job has waited 3 minutes is force-cancelled. Its end starts box-rerun.yml like
// any Check's, which finds the light job cancelled before a runner took it and re-runs the run's
// failed and cancelled jobs as attempt 2, which runs them hosted; GitHub's completion event carries
// the run from here to there, so a rescue stopped after its cancel strands nothing. A box that is
// up, or holding with no CI budget, keeps its light jobs. GitHub answering badly never counts as
// down. The rescue matches light jobs by their label's suffix, not the variable, so emptying the
// variable during an outage still frees what it held.

/**
 * The most REST calls one rescue spends. Every Check shares the workflow token's hourly limit; an
 * up box costs 3 (the heartbeat), a down one 2 more, one or two per active first attempt and one
 * per cancel.
 */
export const maxCalls = 100;
const minute = 60_000;
const checkPath = ".github/workflows/ci.yml";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
export type RescueEnv = {
  api: string;
  repository: string;
  token: string;
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
  let failures = 0;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: "Bearer " + env.token,
    "x-github-api-version": "2022-11-28",
  };
  const send = async (url: string, init: RequestInit) => {
    if (calls >= maxCalls)
      throw new TokenBudget(`the rescue would take more than ${maxCalls} API calls`);
    if (remaining < tokenReserve)
      throw new TokenBudget(
        `the workflow token has ${remaining} of its hourly API calls left, and the rescue leaves ${tokenReserve} for the Checks`,
      );
    calls++;
    const response = await fetcher(url, init).catch((error: Error) => {
      failures++;
      throw error;
    });
    const left = Number(response.headers.get("x-ratelimit-remaining") ?? Number.NaN);
    if (Number.isFinite(left)) remaining = Math.min(remaining, left);
    if (!response.ok) failures++;
    return response;
  };
  const call = async (path: string, method = "GET") => {
    const what = `${method} ${path.split("?")[0]}`;
    for (let attempt = 1; ; attempt++) {
      const response = await send(env.api + "/repos/" + env.repository + path, {
        method,
        headers,
        signal: AbortSignal.timeout(20_000),
      }).catch((error: Error) => error);
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
  const json = async (path: string) => record(await (await call(path)).json());
  /** How many reads so far failed or answered other than 2xx. */
  return { send, call, json, failures: () => failures };
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
    if (error instanceof TokenBudget || api.failures()) {
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

/** This repository's own active first-attempt Checks, newest first. */
async function activeChecks(env: RescueEnv, api: Client) {
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
  return [...listed.values()].filter(
    (run) =>
      String(run.path).split("@")[0] === checkPath &&
      Number(run.run_attempt) === 1 &&
      record(run.head_repository).full_name === env.repository,
  );
}

/** A run's light job queued `queuedMinutes` or more, if it has one. */
async function heldJob(api: Client, id: number, at: number) {
  const holds = (job: Json) =>
    job.status === "queued" &&
    Array.isArray(job.labels) &&
    onLightRunners(job.labels) &&
    at - Date.parse(String(job.created_at)) >= queuedMinutes * minute;
  // Fifty a page, as the router reads a re-run Check's jobs: GitHub answers a hundred for one
  // with a 502, and this run may be re-run after it was listed. Attempt 1's are read either way.
  for (let page = 1; page <= 20; page++) {
    const { jobs } = await api.json(`/actions/runs/${id}/attempts/1/jobs?per_page=50&page=${page}`);
    if (!Array.isArray(jobs)) throw new Error("GitHub listed no jobs");
    const job = jobs.map(record).find(holds);
    if (job || jobs.length < 50) return job;
  }
  return undefined;
}

/** Cancels the Checks a down box holds; false when a cancel GitHub refused left one held. */
export async function rescue(
  env: RescueEnv,
  fetcher: Fetch = fetch,
  clock: Clock = realClock,
  print: (line: string) => void = say,
) {
  const line = (text: string) => print("Light rescue: " + text);
  const api = client(env, fetcher, clock);
  const down = await boxDown(env, api, clock.now, line);
  if (down === undefined) return true;
  const at = clock.now();
  let checks: Json[];
  try {
    checks = await activeChecks(env, api);
  } catch (error) {
    line(`the Checks could not be read (${(error as Error).message}); nothing is cancelled.`);
    return true;
  }
  // Each held run is cancelled as soon as it is found, so a rescue that runs out of calls still
  // frees some, and the next one finds the rest.
  let held = 0;
  let cancelled = true;
  for (const run of checks) {
    const id = Number(run.id);
    let job: Json | undefined;
    try {
      job = await heldJob(api, id, at);
    } catch (error) {
      line(
        `the Checks could not be read past run ${id} (${(error as Error).message}); the next rescue reads the rest.`,
      );
      break;
    }
    if (!job) continue;
    held++;
    // A plain cancel still starts the aggregate, which runs on always(): one already queued for
    // the light runners would wait there, and a run that never ends is never re-run.
    try {
      await api.call(`/actions/runs/${id}/force-cancel`, "POST");
    } catch (error) {
      if (error instanceof TokenBudget) {
        line(`left run ${id} for the next rescue: ${error.message}.`);
        break;
      }
      line(`could not cancel run ${id} (${(error as Error).message}).`);
      cancelled = false;
      continue;
    }
    const waited = Math.floor((at - Date.parse(String(job.created_at))) / minute);
    line(
      `cancelled run ${id}: its ${String(job.name)} job waited ${waited} minutes for the light runners; box-rerun.yml re-runs it hosted once it ends.`,
    );
  }
  line(
    `the box is down (${down}); ${held} of ${checks.length} first-attempt Checks have a light job queued ${queuedMinutes} minutes or more.`,
  );
  return cancelled;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const cancelled = await rescue({
    api: env.GITHUB_API_URL ?? "https://api.github.com",
    repository: env.GITHUB_REPOSITORY ?? "",
    token: env.GITHUB_TOKEN ?? "",
    boxLabel: env.BOX_LABEL ?? "",
    heartbeatLabel: env.BOX_HEARTBEAT_LABEL ?? "",
  });
  if (!cancelled) process.exitCode = 1;
}
