import { shardJob } from "./retry-history.ts";
import { estimator, readDeclaredDurations, setupMinutes, shardRuns } from "./shards.ts";

// Box first: on the first attempt of a main or batch push, or of this repository's own pull
// request, Check fills the self-hosted runners' free CI slots with routable jobs, longest first,
// while the box's own heartbeat is fresh, healthy and grants a CI budget. Hosted runners take the
// rest. Everything runs hosted by default, on a re-run, for fork pull requests, and on any error.
//
// Switch-back: deleting BASALT_CI_BOX_SLOTS, or setting it to 0, sends every job hosted on the
// next Check. A shard already queued for the box can't move back to hosted; the 10-minute
// heartbeat window and the free-slot count bound how much work can be stuck there.
/** Jobs ran at 1.45–1.98× their hosted time on a loaded box (1.06× idle); the timeout check
 * assumes the slow end. */
export const boxSlowdown = 2.0;
export const heartbeatMarker = "box-health:";
export const heartbeatPath = ".github/workflows/box-heartbeat.yml";
const heartbeatWindow = 10 * 60_000;
const sampleSkew = 2 * 60_000;
// The release runners are self-hosted too, so a broad label could hand CI work to them.
const sharedLabels = ["self-hosted", "basalt-release"];
const refusedLabels = [...sharedLabels, "linux", "x64", "arm64"];

/** Only declared e2e shard rows route. Every job type runs slower on the box, and a shard needs
 * only 1.0–1.4 cores, so shards alone keep its CI slots busy. */
export const declaredJobs = ["declared-self-host", "declared-local", "declared-cloud"];
/** A declared shard row: its name in box_jobs, its planned hosted minutes and its job timeout. */
export type BoxShard = { id: string; minutes: number; timeout: number };
export type Matrices = Record<
  string,
  { include: readonly { shard: string; runs: string; timeout: number }[] }
>;
export type Heartbeat = { conclusion: unknown; completedAt: unknown; log: string };
/** Queued and running jobs outside this Check: on hosted runners, and on the box's label. */
export type ActiveJobs = { hosted: number; box: number };
export type BoxObserver = { heartbeat(): Promise<Heartbeat>; active(): Promise<ActiveJobs> };
export type BoxInput = {
  event: string;
  ref: string;
  /** GITHUB_RUN_ATTEMPT; only the first attempt routes. */
  attempt?: string;
  /** This repository, and a pull request's head repository; only the same repository routes. */
  repository?: string;
  headRepository?: string;
  slots?: string;
  label?: string;
  selected: readonly string[];
  matrices: Matrices;
  /** Measured seconds per declared file; defaults to scripts/ci/declared-durations.json. */
  durations?: Record<string, number>;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The selection's declared shard rows with their planned minutes and timeouts. */
export function checkPlan(
  selected: readonly string[],
  matrices: Matrices,
  durations = readDeclaredDurations(),
) {
  const estimate = estimator(durations);
  const shards: BoxShard[] = selected.flatMap((job) =>
    declaredJobs.includes(job)
      ? (matrices[job]?.include ?? []).map((row) => ({
          id: row.shard,
          minutes:
            setupMinutes + shardRuns(row.runs).reduce((sum, run) => sum + estimate(run), 0) / 60,
          timeout: row.timeout,
        }))
      : [],
  );
  return { shards };
}

/** The declared job a box_jobs id belongs to, or undefined when it names no declared shard. */
export function routedJob(id: string) {
  const job = shardJob(id);
  return job && declaredJobs.includes(job) ? job : undefined;
}

/** A shard goes to the box only if it would still finish inside its own timeout at the slow end. */
export const fitsTimeout = (shard: BoxShard) => shard.minutes * boxSlowdown <= shard.timeout;

/** Up to `limit` shards that fit their timeout on the box, longest first. */
export function fillBox(shards: readonly BoxShard[], limit: number) {
  return shards
    .filter(fitsTimeout)
    .sort((a, b) => b.minutes - a.minutes || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, limit))
    .map((shard) => shard.id);
}

export function boxSettings(
  input: Pick<
    BoxInput,
    "event" | "ref" | "attempt" | "slots" | "label" | "repository" | "headRepository"
  >,
) {
  // A fork's pull request never routes: its code is not this repository's. Same-repository pull
  // requests do, each job in a fresh container; the box's own budget keeps release work first.
  if (input.event === "pull_request") {
    if (!input.repository || input.headRepository !== input.repository)
      return "fork pull requests never run on the self-hosted runners";
  } else if (
    input.event !== "push" ||
    !(input.ref === "refs/heads/main" || input.ref.startsWith("refs/heads/batch/"))
  )
    return "only main and batch pushes and this repository's pull requests can route";
  // "Re-run failed jobs" reuses this run's outputs; a re-run must not trust an old box decision.
  if (input.attempt !== "1") return "a re-run always runs hosted";
  if (!/^[1-9]\d{0,2}$/.test(input.slots ?? ""))
    return "BASALT_CI_BOX_SLOTS is unset, 0 or not a positive integer";
  const label = input.label ?? "";
  if (!/^[\w.-]+$/.test(label) || refusedLabels.includes(label.toLowerCase()))
    return "BASALT_CI_BOX_LABEL is unset or names a label other runners share";
  return { slots: Number(input.slots), label };
}

/** The last marked status line of a heartbeat log, if it parses. */
export function heartbeatStatus(log: string) {
  const line = log
    .split(/\r?\n/)
    .map((text) => text.replace(/^\uFEFF?(?:\d{4}-\d\d-\d\dT\S+Z )?/, ""))
    .findLast((text) => text.startsWith(heartbeatMarker));
  if (line === undefined) return undefined;
  try {
    const status = record(JSON.parse(line.slice(heartbeatMarker.length)));
    if (typeof status.at !== "string") return undefined;
    return {
      at: status.at,
      healthy: status.healthy,
      budget: status.ci_budget,
      reason: typeof status.ci_budget_reason === "string" ? status.ci_budget_reason : "",
    };
  } catch {
    return undefined;
  }
}

/** The box's CI budget from its newest heartbeat, or why that heartbeat can't vouch for it. */
export function heartbeatBudget(heartbeat: Heartbeat, now: number) {
  if (heartbeat.conclusion !== "success")
    return "the newest heartbeat ended " + String(heartbeat.conclusion ?? "without a conclusion");
  const end = Date.parse(String(heartbeat.completedAt));
  if (!(now - end <= heartbeatWindow && end - now <= sampleSkew))
    return "the newest heartbeat is older than 10 minutes";
  const status = heartbeatStatus(heartbeat.log);
  if (!status) return "the heartbeat log has no box status";
  if (!(Math.abs(Date.parse(status.at) - end) <= sampleSkew))
    return "the box status was not sampled within 2 minutes of its heartbeat";
  // The reason is the box's own short text; keep it to plain words in the summary.
  const reason = status.reason.replace(/[^\w .,:;%/()+-]/g, "").slice(0, 80);
  const why = reason ? ` (${reason})` : "";
  if (status.healthy !== true) return "the box reported unhealthy" + why;
  const budget = status.budget;
  if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 0)
    return "the box reported no whole-number CI budget";
  if (budget === 0) return "the box's CI budget is 0" + why;
  return { budget, why };
}

export async function routeBox(input: BoxInput, observe: BoxObserver, now = Date.now) {
  const none = (why: string) => ({
    jobs: [] as string[],
    label: "",
    summary: `Box routing: every job runs hosted, because ${why}.`,
  });
  const settings = boxSettings(input);
  if (typeof settings === "string") return none(settings);
  try {
    const plan = checkPlan(input.selected, input.matrices, input.durations);
    if (!plan.shards.length) return none("this Check runs no declared e2e shards");
    const box = heartbeatBudget(await observe.heartbeat(), now());
    if (typeof box === "string") return none(box);
    const active = await observe.active();
    // BASALT_CI_BOX_SLOTS caps what the box's own budget grants.
    const limit = Math.min(settings.slots, box.budget);
    const free = Math.max(0, limit - active.box);
    const slots = `${free} of ${limit} slots free`;
    const budget = `a CI budget of ${box.budget}${box.why}`;
    if (!free)
      return none(`no box slot is free (${active.box} box jobs are active, ${slots}, ${budget})`);
    const jobs = fillBox(plan.shards, free);
    if (!jobs.length)
      return none(`no declared shard fits its timeout at ${boxSlowdown}× its planned minutes`);
    const hosted = plan.shards.length - jobs.length;
    return {
      jobs,
      label: settings.label,
      summary:
        `Box routing: box first. ${jobs.length} declared shards go to the self-hosted runners ` +
        `(${slots}) because the box reported healthy with ${budget}; ${hosted} run hosted, ` +
        `while ${active.hosted} hosted jobs are active elsewhere: ${jobs.join(", ")}.`,
    };
  } catch (error) {
    return none("the box state could not be read: " + (error as Error).message);
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Reads the heartbeat, the repository's hosted load and the box's busy slots through the REST API. */
export function githubObserver(
  env: { api: string; repository: string; token: string; runId: string; label: string },
  fetcher: Fetch = fetch,
): BoxObserver {
  const get = async (path: string) => {
    const response = await fetcher(env.api + "/repos/" + env.repository + path, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + env.token,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(`GitHub returned ${response.status} for ${path.split("?")[0]}`);
    return response;
  };
  const list = async (path: string, key: string) => {
    const items: Record<string, unknown>[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = record(await (await get(`${path}&per_page=100&page=${page}`)).json())[key];
      if (!Array.isArray(batch)) throw new Error("GitHub listed no " + key);
      items.push(...batch.map(record));
      if (batch.length < 100) return items;
    }
    throw new Error("more than 1000 active " + key);
  };
  const boxLabel = env.label.toLowerCase();
  const selfHosted = new Set([boxLabel, ...sharedLabels]);
  const onBox = (job: Record<string, unknown>) =>
    Array.isArray(job.labels) &&
    job.labels.some((label) => String(label).toLowerCase() === boxLabel);
  // Only the box's own scheduled or dispatched runs of this repository can vouch for it; a fork or
  // pull-request run of the same file could print anything.
  const trustedHeartbeat = (run: Record<string, unknown>) =>
    String(run.path).split("@")[0] === heartbeatPath &&
    (run.event === "schedule" || run.event === "workflow_dispatch") &&
    record(run.head_repository).full_name === env.repository;
  // A job on the box's label holds a CI slot; release-label jobs hold neither a slot nor hosted.
  const runner = (job: Record<string, unknown>) => {
    if (!Array.isArray(job.labels)) throw new Error("GitHub listed a job without labels");
    if (onBox(job)) return "box";
    const labels = job.labels.map((label) => String(label).toLowerCase());
    const group = job.runner_group_name;
    return !labels.some((label) => selfHosted.has(label)) &&
      (group === undefined || group === null || group === "GitHub Actions")
      ? "hosted"
      : "other";
  };
  return {
    async heartbeat() {
      const path = "/actions/workflows/box-heartbeat.yml/runs?branch=main&status=completed";
      const runs = record(await (await get(path + "&per_page=20")).json()).workflow_runs;
      if (!Array.isArray(runs)) throw new Error("GitHub listed no heartbeat runs");
      for (const run of runs.map(record).filter(trustedHeartbeat)) {
        if (run.conclusion !== "success")
          return { conclusion: run.conclusion, completedAt: run.updated_at, log: "" };
        // A heartbeat that didn't run on the box's label says nothing about the box.
        const jobs = await list(`/actions/runs/${Number(run.id)}/jobs?filter=latest`, "jobs");
        const job = jobs.find(onBox);
        if (!job) continue;
        const log = await (await get(`/actions/jobs/${Number(job.id)}/logs`)).text();
        return { conclusion: job.conclusion, completedAt: job.completed_at, log };
      }
      throw new Error("no completed heartbeat run from the box");
    },
    async active() {
      const listed = await Promise.all(
        ["in_progress", "queued"].map((status) =>
          list(`/actions/runs?status=${status}`, "workflow_runs"),
        ),
      );
      // The heartbeat's own short job doesn't hold a CI slot.
      const runs = new Set(
        listed
          .flat()
          .filter((run) => String(run.id) !== env.runId && !trustedHeartbeat(run))
          .map((run) => Number(run.id)),
      );
      const jobs = await Promise.all(
        [...runs].map((id) => list(`/actions/runs/${id}/jobs?filter=latest`, "jobs")),
      );
      const counts = { hosted: 0, box: 0 };
      for (const job of jobs.flat()) {
        if (job.status !== "queued" && job.status !== "in_progress") continue;
        const kind = runner(job);
        if (kind === "box") counts.box++;
        else if (kind === "hosted") counts.hosted++;
      }
      return counts;
    },
  };
}
