import { fileURLToPath } from "node:url";
import {
  boxIsUp,
  githubObserver,
  heartbeatBudget,
  tokenReserve,
  TokenBudget,
  type Heartbeat,
} from "./box-router.ts";
import { lightSuffix, selectLightLabel } from "./light-lane.ts";
import { isCheckJob } from "./retry-history.ts";
import { say, supersededPullRequest, type GitHub } from "./workflow-run.ts";

// light-rescue.yml, every 5 minutes. A Check job queued for the light runners can't move to hosted
// runners, so while the box's heartbeat shows it down, each first attempt of this repository's own
// Check whose light job has waited 3 minutes is cancelled, and once it ends its failed and cancelled
// jobs are re-run: attempt 2, which runs every job hosted. A run with a job that failed for real, or
// that a newer Check of its pull request supersedes, stays cancelled. Before each cancel the rescue
// names every run it has taken on in a notice on its own job. A rescue that did not finish leaves
// those notices behind; the next one takes those runs on again and names them again, so a run is
// never left cancelled for want of a rescue that looks. A box that is up, or holding with no CI
// budget, keeps its light jobs. GitHub answering badly never counts as down.

/** How a rescue's notice naming the runs it took on begins; a JSON list of run ids follows. */
export const takenMarker = "light rescue took runs ";
/** How long a light job may wait queued before a down box counts as holding it. */
export const queuedMinutes = 3;
/** How often, and for how long, a cancelled run is read for its end before it is re-run. */
export const pollMs = 5_000;
export const pollLimitMs = 60_000;
/** How many unfinished rescues back a rescue reads, so a few in a row that stopped early lose no run. */
export const unfinishedRescues = 5;
/**
 * The most REST calls one rescue spends. Every Check shares the workflow token's hourly limit; an
 * up box costs 4 (the earlier rescues and the heartbeat), plus 2 for each unfinished rescue before
 * this one; a down one 2 more plus one or two per active first attempt; each run cancelled at most
 * `finishCalls`, and each run an earlier rescue took on at most `carriedCalls`.
 */
export const maxCalls = 100;
/**
 * A run's calls once taken on: its cancel, every poll, its jobs (a Check's fill two pages), its pull
 * request's newer-Check read and its re-run.
 */
export const finishCalls = 1 + (pollLimitMs / pollMs + 1) + 2 + 1 + 1;
/** The same for a run an earlier rescue took on, which ended already: one read, no cancel or polls. */
export const carriedCalls = 1 + 2 + 1 + 1;
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
  let failures = 0;
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
      failures++;
      throw error;
    });
    const left = Number(response.headers.get("x-ratelimit-remaining") ?? Number.NaN);
    if (Number.isFinite(left)) remaining = Math.min(remaining, left);
    if (!response.ok) failures++;
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
  const body = async (path: string, finishing = false): Promise<unknown> =>
    (await call(path, "GET", finishing)).json();
  const json = async (path: string, finishing = false) => record(await body(path, finishing));
  return {
    send,
    call,
    body,
    json,
    calls: () => calls,
    /** How many reads so far failed or answered other than 2xx. */
    failures: () => failures,
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
  // Only the heartbeat's own reads decide whether it could be read.
  const failures = api.failures();
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
    if (error instanceof TokenBudget || api.failures() > failures) {
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

/**
 * The runs the rescues since the last one that finished took on, from their notices. A rescue
 * names a run before it cancels it, so a run one never got to finish is among them even when that
 * rescue was stopped mid-way.
 */
async function earlierTaken(api: Client) {
  const { workflow_runs: runs } = await api.json(
    `/actions/workflows/light-rescue.yml/runs?status=completed&per_page=${unfinishedRescues}`,
  );
  if (!Array.isArray(runs)) throw new Error("GitHub listed no rescue runs");
  const taken = new Set<number>();
  for (const run of runs.map(record)) {
    if (["success", "skipped"].includes(String(run.conclusion))) break;
    const { jobs } = await api.json(`/actions/runs/${Number(run.id)}/jobs?per_page=10`);
    if (!Array.isArray(jobs)) throw new Error("GitHub listed no rescue jobs");
    for (const job of jobs.map(record)) {
      const id = /\/check-runs\/(\d+)$/.exec(String(job.check_run_url))?.[1];
      if (id === undefined) continue;
      const notes = await api.body(`/check-runs/${id}/annotations?per_page=50`);
      if (!Array.isArray(notes)) throw new Error("GitHub listed no annotations");
      for (const note of notes.map(record)) {
        const message = String(note.message);
        if (!message.startsWith(takenMarker)) continue;
        const ids: unknown = JSON.parse(message.slice(takenMarker.length));
        if (!Array.isArray(ids)) throw new Error("a rescue's notice is not a list");
        for (const value of ids) if (Number.isSafeInteger(value) && value > 0) taken.add(value);
      }
    }
  }
  return taken;
}

/** This repository's own first-attempt Checks among the runs listed with `status`. */
async function firstAttempts(env: RescueEnv, api: Client, status: string) {
  const listed: Json[] = [];
  for (let page = 1; ; page++) {
    const { workflow_runs: runs } = await api.json(
      `/actions/workflows/ci.yml/runs?status=${status}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(runs)) throw new Error("GitHub listed no Check runs");
    listed.push(...runs.map(record));
    if (runs.length < 100) break;
    if (page === 10) throw new Error(`more than 1,000 ${status} Check runs`);
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

/** Rescues the Checks a down box holds; false when a run it took on is left unfinished. */
export async function rescue(
  env: RescueEnv,
  fetcher: Fetch = fetch,
  clock: Clock = realClock,
  print: (line: string) => void = say,
  notice: (text: string) => void = (text) => console.log("::notice::" + text),
) {
  const line = (text: string) => print("Light rescue: " + text);
  const label = selectLightLabel(env.lightLabel).toLowerCase();
  if (!label) {
    line(
      `nothing to do: BASALT_CI_LIGHT_LABEL is empty or names no label ending in ${lightSuffix}, so every job runs hosted.`,
    );
    return true;
  }
  const api = client(env, fetcher, clock);
  let finished = true;
  // Every run this rescue has taken on, named again before each cancel: GitHub keeps ten notices a
  // step, and each one names them all.
  const taken = new Set<number>();
  const name = () => notice(takenMarker + JSON.stringify([...taken]));
  const carried = new Set<number>();
  try {
    for (const id of await earlierTaken(api)) carried.add(id);
  } catch (error) {
    // Their runs stay named in their notices, and this rescue fails, so the next one reads them.
    line(`the earlier rescues could not be read (${(error as Error).message}).`);
    finished = false;
  }
  if (carried.size) {
    for (const id of carried) taken.add(id);
    name();
    line(`takes on again the runs earlier rescues left: ${[...carried].join(", ")}.`);
  }

  const box = await boxState(env, api, clock.now, line);
  const held: { run: Json; job: Json }[] = [];
  if (box && "up" in box) line(`the box is up (${box.up}); its light runners take their own jobs.`);
  else if (box) {
    const at = clock.now();
    let checks = 0;
    try {
      const active = new Map<number, Json>();
      for (const status of ["in_progress", "queued"])
        for (const run of await firstAttempts(env, api, status)) active.set(Number(run.id), run);
      checks = active.size;
      for (const [id, run] of active) {
        const job = (await firstAttemptJobs(api, id)).find(
          (candidate) =>
            candidate.status === "queued" &&
            labelled(candidate, label) &&
            at - Date.parse(String(candidate.created_at)) >= queuedMinutes * minute,
        );
        if (job) held.push({ run, job });
      }
    } catch (error) {
      line(`the Checks could not be read (${(error as Error).message}); nothing is cancelled.`);
      held.length = 0;
    }
    line(
      `the box is down (${box.down}); ${held.length} of ${checks} first-attempt Checks have a light job queued ${queuedMinutes} minutes or more.`,
    );
  }

  // Earlier rescues' runs come first: each was cancelled already, or never will be.
  const pending = new Map<number, { cancelled: boolean }>();
  let reserved = 0;
  const room = (id: number, calls: number) => {
    if (api.calls() + reserved + calls > maxCalls) {
      line(`left run ${id} for the next rescue: finishing it would pass ${maxCalls} API calls.`);
      return false;
    }
    reserved += calls;
    return true;
  };
  // A run an earlier rescue named but never cancelled, still held, is cancelled below, which
  // replaces its entry here.
  for (const id of carried) {
    if (room(id, carriedCalls)) pending.set(id, { cancelled: false });
    // Still named in this rescue's notice, which the next one reads.
    else finished = false;
  }
  for (const { run, job } of held) {
    const id = Number(run.id);
    // A held run left uncancelled waits for the next rescue, or for the light runners.
    if (!room(id, finishCalls)) continue;
    taken.add(id);
    name();
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
    const minutes = Math.floor((clock.now() - Date.parse(String(job.created_at))) / minute);
    line(
      `cancelled run ${id}: its ${String(job.name)} job waited ${minutes} minutes for the light runners.`,
    );
    pending.set(id, { cancelled: true });
  }

  const github: GitHub = {
    call: (path, init) => api.call(path, init?.method, true),
    json: async <T>(path: string) => (await api.json(path, true)) as T,
  };
  const boxLabel = env.boxLabel.toLowerCase();
  const rerun = async (id: number, ended: Json) => {
    if (
      String(ended.path).split("@")[0] !== checkPath ||
      record(ended.head_repository).full_name !== env.repository
    )
      return `left run ${id}: it is not this repository's Check.`;
    if (Number(ended.run_attempt) !== 1) return `left run ${id}: something else re-ran it already.`;
    if (ended.conclusion === "success")
      return `left run ${id}: it passed before the cancel landed.`;
    const newer = await supersededPullRequest(
      github,
      { id, attempt: 1, conclusion: String(ended.conclusion) },
      {
        RUN_EVENT: String(ended.event),
        HEAD_BRANCH: String(ended.head_branch),
        GITHUB_REPOSITORY: env.repository,
      },
    );
    if (newer)
      return `left run ${id} cancelled: a newer Check runs for its pull request, and a re-run would cancel it.`;
    // Every run a rescue takes on was cancelled while the box was down, so a box or light job that
    // failed lost its runner, not its test; the aggregate fails on any cancel. Any other failure is
    // a person's to classify.
    const failed = (await firstAttemptJobs(api, id, true))
      .filter(
        (job) =>
          job.conclusion === "failure" &&
          !isCheckJob(String(job.name)) &&
          !labelled(job, label) &&
          !labelled(job, boxLabel),
      )
      .map((job) => String(job.name));
    if (failed.length)
      return `left run ${id} cancelled for a person to classify: ${failed.join(", ")} failed for real.`;
    await api.call(`/actions/runs/${id}/rerun-failed-jobs`, "POST", true);
    return `re-ran run ${id}'s failed and cancelled jobs; attempt 2 runs them hosted.`;
  };
  // Each run is re-run as soon as it reports its end. A run an earlier rescue named that has not
  // ended was never cancelled, and runs on: it is read once.
  const deadline = clock.now() + pollLimitMs;
  while (pending.size) {
    for (const [id, { cancelled }] of pending) {
      const ended = await api.json(`/actions/runs/${id}`, true).catch(() => undefined);
      if (ended?.status !== "completed") {
        if (cancelled) continue;
        pending.delete(id);
        if (ended) line(`left run ${id}: an earlier rescue named it but never cancelled it.`);
        else {
          line(`could not read run ${id}; the next rescue takes it on again.`);
          finished = false;
        }
        continue;
      }
      pending.delete(id);
      try {
        line(await rerun(id, ended));
      } catch (error) {
        line(
          `could not re-run run ${id} (${(error as Error).message}); the next rescue takes it on again.`,
        );
        finished = false;
      }
    }
    if (!pending.size || clock.now() >= deadline) break;
    await clock.wait(pollMs);
  }
  for (const id of pending.keys()) {
    line(
      `run ${id} did not end within ${pollLimitMs / 1000} s of its cancel; the next rescue takes it on again.`,
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
