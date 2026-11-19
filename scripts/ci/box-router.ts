import { shardJob } from "./retry-history.ts";
import { estimator, readDeclaredDurations, setupMinutes, shardRuns } from "./shards.ts";

// Check sends declared e2e shards to the self-hosted runners only on main and batch pushes, only
// while the box's heartbeat is fresh and healthy, and only the part of the Check that would push
// hosted runners past their cap. Every other job, and everything by default, runs hosted.
//
// Switch-back: deleting BASALT_CI_BOX_SLOTS, or setting it to 0, sends every job hosted on the
// next Check. A shard already queued for the box can't move back to hosted; the 10-minute
// heartbeat window and the per-Check budget bound how much work can be stuck there.

/** Concurrent hosted jobs for this repository when BASALT_CI_HOSTED_CAP is unset. */
export const defaultHostedCap = 40;
/** Box minutes each budgeted slot may spend per Check. */
export const slotMinutes = 20;
/** Jobs ran at 1.45–1.98× their hosted time on a loaded box (1.06× idle); budgets assume the
 * slow end. */
export const boxSlowdown = 2.0;
export const heartbeatMarker = "box-health:";
const heartbeatWindow = 10 * 60_000;
const sampleSkew = 2 * 60_000;
// The release runners are self-hosted too, so a broad label could hand CI work to them.
const sharedLabels = ["self-hosted", "basalt-release"];

/** Only declared e2e shard rows route. Every job type runs slower on the box, and a shard needs
 * only 1.0–1.4 cores, so shards alone keep its CI slots busy. */
export const declaredJobs = ["declared-self-host", "declared-local", "declared-cloud"];
/** Matrix jobs start one hosted job per leg; tests pin these counts to the workflow. */
export const matrixLegs: Record<string, number> = {
  "client-desktop": 2,
  "pool-runtime": 2,
  "pool-inventory": 3,
  "production-ops-identity": 8,
};

/** A declared shard row: its name in box_jobs and its planned hosted minutes. */
export type BoxShard = { id: string; minutes: number };
export type Matrices = Record<string, { include: readonly { shard: string; runs: string }[] }>;
export type Heartbeat = { conclusion: unknown; completedAt: unknown; log: string };
export type BoxObserver = { heartbeat(): Promise<Heartbeat>; hostedActive(): Promise<number> };
export type BoxInput = {
  event: string;
  ref: string;
  slots?: string;
  label?: string;
  hostedCap?: string;
  selected: readonly string[];
  matrices: Matrices;
  /** Measured seconds per declared file; defaults to scripts/ci/declared-durations.json. */
  durations?: Record<string, number>;
  /** Jobs this Check runs beside its heavy selection. */
  fixedJobs: number;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The selection's shard rows with their planned minutes, and every hosted job it starts. */
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
        }))
      : [],
  );
  const others = selected.filter((job) => !declaredJobs.includes(job));
  return { shards, jobs: others.reduce((sum, job) => sum + (matrixLegs[job] ?? 1), shards.length) };
}

/** The declared job a box_jobs id belongs to, or undefined when it names no declared shard. */
export function routedJob(id: string) {
  const job = shardJob(id);
  return job && declaredJobs.includes(job) ? job : undefined;
}

/** Longest first; a shard that would overrun the budget is skipped for a shorter one. */
export function fillBox(shards: readonly BoxShard[], limit: number, budget: number) {
  const jobs: string[] = [];
  let minutes = 0;
  for (const shard of [...shards].sort((a, b) => b.minutes - a.minutes || (a.id < b.id ? -1 : 1))) {
    if (jobs.length >= limit) break;
    if (minutes + shard.minutes > budget) continue;
    jobs.push(shard.id);
    minutes += shard.minutes;
  }
  return { jobs, minutes };
}

export function boxSettings(
  input: Pick<BoxInput, "event" | "ref" | "slots" | "label" | "hostedCap">,
) {
  // Pull requests never route, whatever the variables say. The box runs jobs in privileged
  // containers on a host that also runs release work, so unmerged pull-request code must not run
  // there until the CI slots are isolated.
  if (input.event === "pull_request") return "pull requests never run on the self-hosted runners";
  if (
    input.event !== "push" ||
    !(input.ref === "refs/heads/main" || input.ref.startsWith("refs/heads/batch/"))
  )
    return "only main and batch pushes can route";
  if (!/^[1-9]\d{0,2}$/.test(input.slots ?? ""))
    return "BASALT_CI_BOX_SLOTS is unset, 0 or not a positive integer";
  const label = input.label ?? "";
  if (!/^[\w.-]+$/.test(label) || sharedLabels.includes(label.toLowerCase()))
    return "BASALT_CI_BOX_LABEL is unset or names a label the release runners share";
  const cap = input.hostedCap ? Number(input.hostedCap) : defaultHostedCap;
  if (!/^\d*$/.test(input.hostedCap ?? "") || !Number.isSafeInteger(cap))
    return "BASALT_CI_HOSTED_CAP is not a whole number";
  return { slots: Number(input.slots), label, cap };
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
    return typeof status.at === "string" ? { healthy: status.healthy, at: status.at } : undefined;
  } catch {
    return undefined;
  }
}

/** Why the newest heartbeat can't vouch for the box, or undefined when it can. */
export function heartbeatProblem(heartbeat: Heartbeat, now: number) {
  if (heartbeat.conclusion !== "success")
    return "the newest heartbeat ended " + String(heartbeat.conclusion ?? "without a conclusion");
  const end = Date.parse(String(heartbeat.completedAt));
  if (!(now - end <= heartbeatWindow && end - now <= sampleSkew))
    return "the newest heartbeat is older than 10 minutes";
  const status = heartbeatStatus(heartbeat.log);
  if (!status) return "the heartbeat log has no box status";
  if (!(Math.abs(Date.parse(status.at) - end) <= sampleSkew))
    return "the box status was not sampled within 2 minutes of its heartbeat";
  if (status.healthy !== true) return "the box reported unhealthy";
  return undefined;
}

export async function routeBox(input: BoxInput, observe: BoxObserver, now = Date.now) {
  const none = (why: string) => ({
    jobs: [] as string[],
    summary: `Box routing: every job runs hosted, because ${why}.`,
  });
  const settings = boxSettings(input);
  if (typeof settings === "string") return none(settings);
  try {
    const plan = checkPlan(input.selected, input.matrices, input.durations);
    if (!plan.shards.length) return none("this Check runs no declared e2e shards");
    const own = input.fixedJobs + plan.jobs;
    const unhealthy = heartbeatProblem(await observe.heartbeat(), now());
    if (unhealthy) return none(unhealthy);
    const active = await observe.hostedActive();
    const load = `${active} hosted jobs are active and this Check adds ${own}, against a cap of ${settings.cap}`;
    const excess = active + own - settings.cap;
    if (excess <= 0) return none(load);
    const budget = (settings.slots * slotMinutes) / boxSlowdown;
    const fill = fillBox(plan.shards, excess, budget);
    if (!fill.jobs.length) return none(`no declared shard fits the ${budget}-minute budget`);
    return {
      jobs: fill.jobs,
      summary:
        `Box routing: ${fill.jobs.length} declared shards (${Math.round(fill.minutes)} of ${budget} budgeted ` +
        `hosted minutes) go to the self-hosted runners, because the box reported healthy and ` +
        `${load}: ${fill.jobs.join(", ")}.`,
    };
  } catch (error) {
    return none("the box state could not be read: " + (error as Error).message);
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Reads the heartbeat and the repository's hosted load through the REST API. */
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
  const box = new Set([env.label, ...sharedLabels].map((label) => label.toLowerCase()));
  const hosted = (job: Record<string, unknown>) => {
    if (!Array.isArray(job.labels)) throw new Error("GitHub listed a job without labels");
    const group = job.runner_group_name;
    return (
      !job.labels.some((label) => box.has(String(label).toLowerCase())) &&
      (group === undefined || group === null || group === "GitHub Actions")
    );
  };
  return {
    async heartbeat() {
      const path = "/actions/workflows/box-heartbeat.yml/runs?branch=main&status=completed";
      const runs = record(await (await get(path + "&per_page=1")).json()).workflow_runs;
      const run = Array.isArray(runs) ? record(runs[0]) : {};
      if (!run.id) throw new Error("no completed heartbeat run");
      if (run.conclusion !== "success")
        return { conclusion: run.conclusion, completedAt: run.updated_at, log: "" };
      const [job] = await list(`/actions/runs/${Number(run.id)}/jobs?filter=latest`, "jobs");
      if (!job) throw new Error("the heartbeat run has no job");
      const log = await (await get(`/actions/jobs/${Number(job.id)}/logs`)).text();
      return { conclusion: job.conclusion, completedAt: job.completed_at, log };
    },
    async hostedActive() {
      const listed = await Promise.all(
        ["in_progress", "queued"].map((status) =>
          list(`/actions/runs?status=${status}`, "workflow_runs"),
        ),
      );
      const runs = new Set(
        listed.flat().flatMap((run) => (String(run.id) === env.runId ? [] : [Number(run.id)])),
      );
      const jobs = await Promise.all(
        [...runs].map((id) => list(`/actions/runs/${id}/jobs?filter=latest`, "jobs")),
      );
      return jobs
        .flat()
        .filter((job) => (job.status === "queued" || job.status === "in_progress") && hosted(job))
        .length;
    },
  };
}
