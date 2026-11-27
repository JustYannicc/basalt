import { fileURLToPath } from "node:url";
import { tokenReserve, TokenBudget } from "./box-router.ts";
import { onLightRunners, queuedMinutes } from "./light-lane.ts";
import { say } from "./workflow-run.ts";

// light-rescue.yml, every 5 minutes. A Check job queued for the light runners can't move to hosted
// runners. Only the first attempt of a push to main uses them (scripts/ci/light-lane.ts): a few
// seconds-long jobs a few times an hour on two runners, which never queue behind each other for
// minutes. So a light job of main's Check that has waited 3 minutes means the lane isn't taking
// jobs (its runners are down, or the variable names a label none carries), and that Check is
// force-cancelled whatever the box's heartbeat says. Its end starts box-rerun.yml like any Check's,
// which finds the light job cancelled before a runner took it and re-runs the run's failed and
// cancelled jobs as attempt 2, which runs them hosted; GitHub's completion event carries the run
// from here to there, so a rescue stopped after its cancel strands nothing. A rescue that freed a
// Check ends red, so a stopped lane shows. GitHub answering badly never cancels. Light jobs are
// matched by their label's suffix, not the variable, so emptying it still frees what it held.

/**
 * The most REST calls one rescue spends. Every Check shares the workflow token's hourly limit; a
 * rescue costs 2 (main's active Checks), one or two per active first attempt and one per cancel.
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

/** Main's own active first-attempt push Checks old enough to hold a light job, newest first. */
async function activeChecks(env: RescueEnv, api: Client, at: number) {
  const listed = new Map<number, Json>();
  for (const status of ["in_progress", "queued"])
    for (let page = 1; ; page++) {
      const { workflow_runs: runs } = await api.json(
        `/actions/workflows/ci.yml/runs?branch=main&event=push&status=${status}&per_page=100&page=${page}`,
      );
      if (!Array.isArray(runs)) throw new Error("GitHub listed no Check runs");
      for (const run of runs.map(record)) listed.set(Number(run.id), run);
      if (runs.length < 100) break;
      if (page === 10) throw new Error("more than 1,000 active Check runs");
    }
  return [...listed.values()].filter(
    (run) =>
      String(run.path).split("@")[0] === checkPath &&
      run.event === "push" &&
      run.head_branch === "main" &&
      Number(run.run_attempt) === 1 &&
      record(run.head_repository).full_name === env.repository &&
      at - Date.parse(String(run.created_at)) >= queuedMinutes * minute,
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

/**
 * Cancels main's Checks the light lane holds. `freed` counts the cancels; `refused` the held ones a
 * cancel GitHub refused left held. Either makes the run red.
 */
export async function rescue(
  env: RescueEnv,
  fetcher: Fetch = fetch,
  clock: Clock = realClock,
  print: (line: string) => void = say,
) {
  const line = (text: string) => print("Light rescue: " + text);
  const api = client(env, fetcher, clock);
  const result = { freed: 0, refused: 0 };
  const at = clock.now();
  let checks: Json[];
  try {
    checks = await activeChecks(env, api, at);
  } catch (error) {
    line(`main's Checks could not be read (${(error as Error).message}); nothing is cancelled.`);
    return result;
  }
  // Each held run is cancelled as soon as it is found, so a rescue that runs out of calls still
  // frees some, and the next one finds the rest.
  let held = 0;
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
      result.refused++;
      continue;
    }
    result.freed++;
    const waited = Math.floor((at - Date.parse(String(job.created_at))) / minute);
    line(
      `cancelled run ${id}: its ${String(job.name)} job waited ${waited} minutes for the light runners; box-rerun.yml re-runs it hosted once it ends.`,
    );
  }
  line(
    `${held} of ${checks.length} first attempts of main's Check have a light job queued ${queuedMinutes} minutes or more.`,
  );
  if (held)
    line(
      "the light lane is not taking main's jobs: its runners are down, or BASALT_CI_LIGHT_LABEL names a label none carries. Delete the variable to run main's Check hosted until it is fixed.",
    );
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const { freed, refused } = await rescue({
    api: env.GITHUB_API_URL ?? "https://api.github.com",
    repository: env.GITHUB_REPOSITORY ?? "",
    token: env.GITHUB_TOKEN ?? "",
  });
  if (freed || refused) process.exitCode = 1;
}
