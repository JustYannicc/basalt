import { shardJob } from "./retry-history.ts";
import { estimator, readDeclaredDurations, setupMinutes, shardRuns } from "./shards.ts";

// Box first: on the first attempt of a main or batch push, or of this repository's own pull
// request, Check fills the self-hosted runners' free CI slots with routable jobs, longest first,
// while the box's own heartbeat is fresh, healthy and grants a CI budget. Hosted runners take the
// rest. Everything runs hosted by default, on a re-run, for fork pull requests, and on any error.
//
// Switch-back: deleting BASALT_CI_BOX_SLOTS, or setting it to 0, sends every job hosted on the
// next Check. A shard already queued for the box can't move back to hosted; the 10-minute
// heartbeat window and the free-slot count bound how much work can be stuck there. A Check waits
// for the ones that started selecting before it, and counts the jobs they placed before GitHub lists
// them, so overlapping Checks don't fill the same slots; two whose selects start within GitHub's
// listing lag, seconds, still can, and the box's own budget then holds back what it has no room for.
/** Jobs ran at 1.45–1.98× their hosted time on a loaded box (1.06× idle); the timeout check
 * assumes the slow end. */
export const boxSlowdown = 2.0;
export const heartbeatMarker = "box-health:";
export const heartbeatPath = ".github/workflows/box-heartbeat.yml";
const heartbeatWindow = 10 * 60_000;
const staleHeartbeat = "the newest heartbeat is older than 10 minutes";
// Each Check's start triggers a heartbeat (box-heartbeat.yml's workflow_run), which lands within
// seconds; after a quiet spell select waits that long for it rather than finding only a stale one.
const heartbeatRetries = 4;
const heartbeatRetryMs = 15_000;
const sampleSkew = 2 * 60_000;
// A select runs about a minute, so a Check whose select started first has placed by then; a later
// one waits that long, and a select still running after 5 minutes is stuck, not placing.
const selectingRetries = 6;
const selectingRetryMs = 15_000;
const stuckSelect = 5 * 60_000;
// After its select ends GitHub lists box-watch within seconds; a minute covers a slow listing.
const listingLag = 60_000;
/** How select's annotation naming the jobs it placed on the box begins; a JSON list follows. */
export const placementMarker = "box placement ";
// The release runners are self-hosted too, so a broad label could hand CI work to them.
const sharedLabels = ["self-hosted", "basalt-release"];
const refusedLabels = [...sharedLabels, "linux", "x64", "arm64"];

/** Declared e2e shard rows route, planned from their files' measured durations. */
export const declaredJobs = ["declared-self-host", "declared-local", "declared-cloud"];
/**
 * Other jobs route only once a box bench has run them, with every step green, within the floor of
 * the Checks they run in; a job joins this table with its bench. `minutes` is the slowest hosted
 * run in full Check 44894443635, or for the fast lane's jobs in batch three's pull request run
 * 44910641265; `timeout` is the job's own, which the workflow test keeps equal to ci.yml. A matrix
 * job routes leg by leg, as `<job>:<leg>`.
 */
export const namedJobs: Record<
  string,
  { minutes: number | Record<string, number>; timeout: number }
> = {
  "production-ops-identity": {
    minutes: {
      credentials: 8.3,
      release: 6.3,
      "without-server": 6.2,
      host: 6.0,
      database: 5.9,
      role: 5.9,
      physical: 5.1,
      diagnostics: 4.0,
    },
    timeout: 25,
  },
  // The fast lane's, which every pull request push runs. `fast` itself stays hosted: it is the
  // fast lane's longest job, so the box would have to beat GitHub's runners at it.
  "client-connection": { minutes: 5.3, timeout: 12 },
  "browser-install": { minutes: 1.8, timeout: 10 },
};
/** A routable row: its name in box_jobs, its planned hosted minutes and its job timeout. */
export type BoxShard = { id: string; minutes: number; timeout: number };

/**
 * The memory a box job holds at its peak, in GiB: the peak measured per job on the box, file cache
 * included because it counts against the CI slice's limit, rounded up. declared-cloud reaches 14.0
 * (its slot's cap; 8.5 of it anonymous), browser-install 11.2 and client-connection 1.6. A job kind
 * not yet measured there takes the declared-cloud price.
 */
export const boxMemoryGiB: Record<string, number> = {
  "declared-cloud": 14,
  "browser-install": 12,
  "client-connection": 2,
};
const unmeasuredGiB = boxMemoryGiB["declared-cloud"]!;
const routableKinds = [...declaredJobs, ...Object.keys(namedJobs)].sort(
  (a, b) => b.length - a.length,
);
/** A box job's memory price by its box_jobs id or its job name, such as `declared-cloud-3`. */
export function memoryPrice(name: string) {
  const kind = routableKinds.find(
    (job) => name === job || (/^[-: (]/.test(name.slice(job.length)) && name.startsWith(job)),
  );
  return (kind === undefined ? undefined : boxMemoryGiB[kind]) ?? unmeasuredGiB;
}
export type Matrices = Record<
  string,
  { include: readonly { shard: string; runs: string; timeout: number }[] }
>;
export type Heartbeat = { conclusion: unknown; completedAt: unknown; log: string };
/** Queued and running jobs outside this Check: on hosted runners, and on the box's label. */
export type ActiveJobs = {
  hosted: number;
  box: number;
  /**
   * The names of those box jobs, and of the ones other Checks placed that GitHub doesn't list yet
   * (counted in `box` too): each holds its memory price on the box.
   */
  boxJobs?: readonly string[];
  /** Other Checks that started selecting before this one and may still place box jobs. */
  selecting?: number;
};
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
  /**
   * The box's own heartbeat runner's label. Without one a full or holding box's heartbeat waits
   * behind its jobs, so box-watch could not tell holding from down: no second wave is planned.
   */
  heartbeatLabel?: string;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The selection's routable rows with their planned minutes and timeouts. */
export function checkPlan(
  selected: readonly string[],
  matrices: Matrices,
  durations = readDeclaredDurations(),
) {
  const estimate = estimator(durations);
  const shards: BoxShard[] = selected.flatMap((job): BoxShard[] => {
    if (declaredJobs.includes(job))
      return (matrices[job]?.include ?? []).map((row) => ({
        id: row.shard,
        minutes:
          setupMinutes + shardRuns(row.runs).reduce((sum, run) => sum + estimate(run), 0) / 60,
        timeout: row.timeout,
      }));
    const named = namedJobs[job];
    if (!named) return [];
    const { minutes, timeout } = named;
    return typeof minutes === "number"
      ? [{ id: job, minutes, timeout }]
      : Object.entries(minutes).map(([leg, legMinutes]) => ({
          id: `${job}:${leg}`,
          minutes: legMinutes,
          timeout,
        }));
  });
  return { shards };
}

/** The job a box_jobs id belongs to, or undefined when it names no routable row. */
export function routedJob(id: string) {
  const job = shardJob(id);
  if (job && declaredJobs.includes(job)) return job;
  const [name = "", leg, ...rest] = id.split(":");
  const minutes = namedJobs[name]?.minutes;
  if (minutes === undefined || rest.length) return undefined;
  const legs = typeof minutes === "number" ? undefined : Object.keys(minutes);
  return (legs ? leg !== undefined && legs.includes(leg) : leg === undefined) ? name : undefined;
}

/** A shard goes to the box only if it would still finish inside its own timeout at the slow end. */
export const fitsTimeout = (shard: BoxShard) => shard.minutes * boxSlowdown <= shard.timeout;

/** Up to `limit` shards that fit their timeout on the box, longest first. */
export function fillBox(shards: readonly BoxShard[], limit: number) {
  return planBox(shards, limit, 0).map((job) => job.id);
}

/**
 * The pace a second wave is planned at: the box's own worst case, not its best. Box jobs ran at
 * 1.02–1.16× their hosted time under the load guard, and at 2.2–2.8× in a full Check that gates
 * overran; a wave planned at a faster pace than the one ahead of it really runs at is cancelled
 * while the box is healthy.
 */
export const waveSlowdown = boxSlowdown;
/** A full suite's floor: its longest hosted jobs run 17.5–19.3 minutes, plus select. */
export const fullCheckFloor = 20;
/** At most this many jobs per free slot, counted over all slots: some start at once, the rest wait. */
export const boxWaves = 2;

/**
 * Box jobs for `free` slots, longest first. Each free slot takes a job at once; a second wave waits
 * on the box for whichever slot frees first, but only when it still ends by `floor` minutes at the
 * keep rule's pace. The box starts a waiting job only when its own budget has room for it.
 */
export function planBox(
  shards: readonly BoxShard[],
  free: number,
  floor: number,
  memoryGiB = Number.POSITIVE_INFINITY,
) {
  const slots: number[] = Array.from({ length: Math.max(0, free) }, () => 0);
  // The box starts a waiting job as soon as its own budget has room, not when a slot frees, so
  // every planned job may run at once: together they fit the memory.
  let memory = 0;
  const planned: { id: string; minutes: number; wave: 1 | 2 }[] = [];
  const fitting = shards
    .filter(fitsTimeout)
    .sort((a, b) => b.minutes - a.minutes || (a.id < b.id ? -1 : 1));
  for (const shard of fitting) {
    if (!slots.length || planned.length >= slots.length * boxWaves) break;
    const slot = slots.indexOf(Math.min(...slots));
    const start = slots[slot]!;
    const end = start + shard.minutes * waveSlowdown;
    // A waiting job is taken only on a known plan: no planned minutes or no floor runs it hosted.
    if (start > 0 && !(shard.minutes > 0 && end <= floor)) continue;
    const price = memoryPrice(shard.id);
    if (memory + price > memoryGiB) continue;
    memory += price;
    slots[slot] = end;
    planned.push({ id: shard.id, minutes: shard.minutes, wave: start > 0 ? 2 : 1 });
  }
  return planned;
}

/** The Check's floor for its plan: a full suite's, or the longest routable row's. */
export function checkFloor(shards: readonly BoxShard[]) {
  const longest = Math.max(0, ...shards.map((shard) => shard.minutes));
  const declared = shards.some((shard) => declaredJobs.includes(shardJob(shard.id) ?? ""));
  return Math.max(longest, declared ? fullCheckFloor : 0);
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
      memory: status.ci_memory_gib,
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
  if (!(now - end <= heartbeatWindow && end - now <= sampleSkew)) return staleHeartbeat;
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
  if (budget === 0) return zeroBudget + why;
  // What the CI slice can give box jobs. A box that publishes none has no memory bound here; one
  // that publishes something unreadable routes nothing, like any other unreadable status.
  const memory = status.memory;
  if (memory !== undefined && (typeof memory !== "number" || !Number.isFinite(memory)))
    return "the box reported no readable CI memory";
  return {
    budget,
    why,
    memoryGiB: memory === undefined ? Number.POSITIVE_INFINITY : Math.max(0, memory),
  };
}

/** The heartbeat runner's own label, or "" when it is unset or one other runners share. */
export const heartbeatRunnerLabel = (label = "") =>
  /^[\w.-]+$/.test(label) && !refusedLabels.includes(label.toLowerCase()) ? label : "";

const zeroBudget = "the box's CI budget is 0";

/** Whether the newest heartbeat shows a healthy box: one that grants no budget now is holding. */
export function boxIsUp(heartbeat: Heartbeat, now: number) {
  const budget = heartbeatBudget(heartbeat, now);
  return typeof budget !== "string" || budget.startsWith(zeroBudget);
}

export async function routeBox(
  input: BoxInput,
  observe: BoxObserver,
  now = Date.now,
  wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const none = (why: string) => ({
    jobs: [] as string[],
    plan: {} as Record<string, { minutes: number; wave: 1 | 2 }>,
    label: "",
    floor: 0,
    summary: `Box routing: every job runs hosted, because ${why}.`,
  });
  const settings = boxSettings(input);
  if (typeof settings === "string") return none(settings);
  try {
    const plan = checkPlan(input.selected, input.matrices, input.durations);
    if (!plan.shards.length) return none("this Check runs no job the box can take");
    let box = heartbeatBudget(await observe.heartbeat(), now());
    for (let tries = 0; box === staleHeartbeat && tries < heartbeatRetries; tries++) {
      await wait(heartbeatRetryMs);
      box = heartbeatBudget(await observe.heartbeat(), now());
    }
    if (typeof box === "string") return none(box);
    // A Check that started selecting first places first; what it placed counts once its select ends.
    let active = await observe.active();
    for (let tries = 0; active.selecting && tries < selectingRetries; tries++) {
      await wait(selectingRetryMs);
      active = await observe.active();
    }
    if (active.selecting)
      return none(
        active.selecting === 1
          ? "a Check that started selecting first is still placing its box jobs"
          : `${active.selecting} Checks that started selecting first are still placing their box jobs`,
      );
    // BASALT_CI_BOX_SLOTS caps what the box's own budget grants.
    const limit = Math.min(settings.slots, box.budget);
    const free = Math.max(0, limit - active.box);
    // Every other Check's box job holds its price: queued, running, or placed and not listed yet.
    const memoryGiB =
      box.memoryGiB - (active.boxJobs ?? []).reduce((sum, name) => sum + memoryPrice(name), 0);
    const room = Number.isFinite(memoryGiB)
      ? `, ${Math.max(0, Math.floor(memoryGiB))} GiB of memory free`
      : "";
    const slots = `${free} of ${limit} slots free${room}`;
    const budget = `a CI budget of ${box.budget}${box.why}`;
    if (!free)
      return none(`no box slot is free (${active.box} box jobs are active, ${slots}, ${budget})`);
    const floor = checkFloor(plan.shards);
    // A job may wait on the box only while its heartbeat runs on its own runner: one that queued
    // behind CI jobs would go stale, and box-watch would take a holding box for a down one.
    // A heartbeat on the CI runners' own label would still queue behind them.
    const ownRunner =
      heartbeatRunnerLabel(input.heartbeatLabel) !== "" &&
      input.heartbeatLabel?.toLowerCase() !== settings.label.toLowerCase();
    const planned = planBox(plan.shards, free, ownRunner ? floor : 0, memoryGiB);
    if (!planned.length)
      return none(
        plan.shards.some(fitsTimeout)
          ? `no routable job fits the box's free memory (${slots}, ${budget})`
          : `no routable job fits its timeout at ${boxSlowdown}× its planned minutes`,
      );
    const jobs = planned.map((job) => job.id);
    const waiting = planned.filter((job) => job.wave === 2).length;
    const hosted = plan.shards.length - jobs.length;
    const wave = waiting
      ? `; ${waiting} of these jobs wait on the box for a slot that frees by the ${floor.toFixed(0)}-minute floor`
      : "";
    return {
      jobs,
      plan: Object.fromEntries(
        planned.map((job) => [job.id, { minutes: job.minutes, wave: job.wave }]),
      ),
      label: settings.label,
      floor,
      summary:
        `Box routing: box first. ${jobs.length} ${jobs.length === 1 ? "job goes" : "jobs go"} to the self-hosted runners ` +
        `(${slots}) because the box reported healthy with ${budget}${wave}; ${hosted} run hosted, ` +
        `while ${active.hosted} hosted jobs are active elsewhere: ${jobs.join(", ")}.`,
    };
  } catch (error) {
    return none("the box state could not be read: " + (error as Error).message);
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Reads the heartbeat, the repository's hosted load and the box's busy slots through the REST API. */
export function githubObserver(
  env: {
    api: string;
    repository: string;
    token: string;
    runId: string;
    label: string;
    /** The box's own heartbeat runner's label, when it has one. */
    heartbeatLabel?: string;
  },
  fetcher: Fetch = fetch,
  now: () => number = Date.now,
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
  // GitHub answers 502 to a hundred jobs a page of a Check that was re-run, every time; fifty works.
  const perPage = 50;
  const list = async (path: string, key: string) => {
    const items: Record<string, unknown>[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = record(await (await get(`${path}&per_page=${perPage}&page=${page}`)).json())[
        key
      ];
      if (!Array.isArray(batch)) throw new Error("GitHub listed no " + key);
      items.push(...batch.map(record));
      if (batch.length < perPage) return items;
    }
    throw new Error("more than 1000 active " + key);
  };
  const boxLabel = env.label.toLowerCase();
  const selfHosted = new Set([boxLabel, ...sharedLabels]);
  // A heartbeat label that other runners share could let them vouch for the box, so it is refused.
  const heartbeatLabel = (env.heartbeatLabel ?? "").toLowerCase();
  const onHeartbeatRunner = (job: Record<string, unknown>) =>
    heartbeatRunnerLabel(heartbeatLabel) !== "" &&
    Array.isArray(job.labels) &&
    job.labels.some((label) => String(label).toLowerCase() === heartbeatLabel);
  const onBox = (job: Record<string, unknown>) =>
    Array.isArray(job.labels) &&
    job.labels.some((label) => String(label).toLowerCase() === boxLabel);
  // Only this repository's own heartbeat file on main can vouch for the box: its scheduled and
  // dispatched runs on main, and the runs a Check's start triggers, which always run the default
  // branch's file. A fork, a pull-request run or a dispatch on another branch could print anything.
  const trustedHeartbeat = (run: Record<string, unknown>) =>
    String(run.path).split("@")[0] === heartbeatPath &&
    record(run.head_repository).full_name === env.repository &&
    (run.event === "workflow_run" ||
      ((run.event === "schedule" || run.event === "workflow_dispatch") &&
        run.head_branch === "main"));
  const checkRun = (run: Record<string, unknown>) =>
    String(run.path).split("@")[0] === ".github/workflows/ci.yml";
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
  const named = (jobs: readonly Record<string, unknown>[], name: string) =>
    jobs.find((job) => job.name === name);
  const started = (job: Record<string, unknown> | undefined) => Date.parse(String(job?.started_at));
  /** The jobs a finished select placed on the box, from its annotation; undefined when it has none. */
  const placement = async (select: Record<string, unknown>) => {
    const id = /\/check-runs\/(\d+)$/.exec(String(select.check_run_url))?.[1];
    if (id === undefined) return undefined;
    const notes: unknown = await (await get(`/check-runs/${id}/annotations?per_page=50`)).json();
    if (!Array.isArray(notes)) throw new Error("GitHub listed no annotations");
    const message = notes
      .map((item) => String(record(item).message))
      .find((text) => text.startsWith(placementMarker));
    if (message === undefined) return undefined;
    const jobs: unknown = JSON.parse(message.slice(placementMarker.length));
    if (!Array.isArray(jobs)) throw new Error("select's box placement is not a list");
    return jobs.map(String);
  };
  return {
    async heartbeat() {
      // Triggered heartbeats cancel each other in flight, so a page holds many cancelled runs.
      const path = "/actions/workflows/box-heartbeat.yml/runs?status=completed";
      const runs = record(await (await get(path + "&per_page=50")).json()).workflow_runs;
      if (!Array.isArray(runs)) throw new Error("GitHub listed no heartbeat runs");
      for (const run of runs.map(record).filter(trustedHeartbeat)) {
        // A newer heartbeat replaced it; a failed one still stops routing.
        if (run.conclusion === "cancelled") continue;
        if (run.conclusion !== "success")
          return { conclusion: run.conclusion, completedAt: run.updated_at, log: "" };
        // A heartbeat that didn't run on the box's label says nothing about the box.
        const jobs = await list(`/actions/runs/${Number(run.id)}/jobs?filter=latest`, "jobs");
        const job = jobs.find((candidate) => onBox(candidate) || onHeartbeatRunner(candidate));
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
      // Box-label jobs come only from Check runs (the heartbeat's own short job holds no CI slot),
      // so only their jobs are listed: every same-repository push routes now, and listing every
      // workflow's runs would spend the token's shared hourly request limit.
      const runs = new Map(
        listed
          .flat()
          .filter((run) => String(run.id) !== env.runId && checkRun(run))
          .map((run) => [Number(run.id), run] as const),
      );
      const [own, ...jobs] = await Promise.all(
        [Number(env.runId), ...runs.keys()].map((id) =>
          list(`/actions/runs/${id}/jobs?filter=latest`, "jobs"),
        ),
      );
      // This Check's own select start orders it against the others selecting now. One that started
      // first places first and is waited for; one that started later waits for this one.
      const ownStart = started(named(own!, "select"));
      const ownId = Number(env.runId);
      const first = (start: number, id: number) =>
        !(start > ownStart) && (start !== ownStart || id < ownId);
      const counts = { hosted: 0, box: 0, boxJobs: [] as string[], selecting: 0 };
      const placed = await Promise.all(
        [...runs].map(async ([id, run], index) => {
          const runJobs = jobs[index]!;
          for (const job of runJobs) {
            if (job.status !== "queued" && job.status !== "in_progress") continue;
            const kind = runner(job);
            if (kind === "box") {
              counts.box++;
              counts.boxJobs.push(String(job.name));
            } else if (kind === "hosted") counts.hosted++;
          }
          // Only this repository's own first attempts place box jobs.
          if (
            Number(run.run_attempt ?? 1) !== 1 ||
            record(run.head_repository).full_name !== env.repository
          )
            return [];
          const select = named(runJobs, "select");
          if (select?.status === "in_progress") {
            const start = started(select);
            if (first(start, id) && !(now() - start > stuckSelect)) counts.selecting++;
            return [];
          }
          if (select?.conclusion !== "success") return [];
          // box-watch exists only when select placed box jobs, and ends once each has started.
          const watch = named(runJobs, "box-watch");
          if (watch === undefined) {
            if (now() - Date.parse(String(select.completed_at)) < listingLag) counts.selecting++;
            return [];
          }
          if (watch.status === "completed") return [];
          // Its box jobs wait for long-started, a hosted job that can queue for minutes, before
          // GitHub lists them; select's annotation names them meanwhile.
          const jobsPlaced = await placement(select);
          if (jobsPlaced === undefined) {
            // A select from before the annotation existed: unknown until its jobs are listed, and
            // not held for longer than a select may run.
            const ended = Date.parse(String(select.completed_at));
            if (!runJobs.some(onBox) && !(now() - ended > stuckSelect)) counts.selecting++;
            return [];
          }
          const unlisted = Math.max(0, jobsPlaced.length - runJobs.filter(onBox).length);
          return [...jobsPlaced].sort((a, b) => memoryPrice(b) - memoryPrice(a)).slice(0, unlisted);
        }),
      );
      for (const name of placed.flat()) {
        counts.box++;
        counts.boxJobs.push(name);
      }
      return counts;
    },
  };
}
