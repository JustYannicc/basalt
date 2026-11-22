import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { heavyJobs } from "./ci/areas.ts";
import {
  boxSettings,
  boxSlowdown,
  checkPlan,
  declaredJobs,
  fillBox,
  fitsTimeout,
  githubObserver,
  heartbeatMarker,
  heartbeatPath,
  namedJobs,
  routeBox,
  routedJob,
  type BoxInput,
  type BoxObserver,
  type Matrices,
} from "./ci/box-router.ts";
import { conditionalJobs, fastJobs, gateErrors } from "./ci/gate.ts";
import { declaredMatrices } from "./ci/shards.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const workflow = parse(read(".github/workflows/ci.yml"));
const heartbeatSource = read(".github/workflows/box-heartbeat.yml");
const heartbeatWorkflow = parse(heartbeatSource);

const now = Date.parse("2026-11-19T12:00:00Z");
// routeBox waits between heartbeat reads when the newest is stale; tests never sleep for real.
const noWait = async () => {};
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
// The box's status object, trimmed to the fields a test varies.
const statusLine = (at: string, healthy: unknown, fields: Record<string, unknown> = {}) =>
  heartbeatMarker +
  JSON.stringify({
    at,
    healthy,
    ci_budget: 2,
    ci_budget_reason: "release slot busy",
    ci_busy: 0,
    ci_slots: 2,
    ci_online: 2,
    release_busy: 1,
    cpu_some_avg60: 15.41,
    ...fields,
  });
const budgetLog = (fields: Record<string, unknown>) => statusLine(minutesAgo(1), true, fields);
const healthyLog = [
  '2026-11-19T11:58:58.1000000Z ##[group]Run status="$(head -c 4096 /opt/basalt-health/status.json)"',
  "2026-11-19T11:58:58.1000000Z printf 'box-health:%s\\n' \"$status\"",
  "2026-11-19T11:58:58.2000000Z " + statusLine(minutesAgo(1.5), true),
].join("\n");
const observer = (
  overrides: Partial<{
    log: string;
    completedAt: string;
    conclusion: string;
    hosted: number;
    box: number;
  }> = {},
) => {
  const calls = { heartbeat: 0, active: 0 };
  const box: BoxObserver = {
    async heartbeat() {
      calls.heartbeat++;
      return {
        conclusion: overrides.conclusion ?? "success",
        completedAt: overrides.completedAt ?? minutesAgo(1),
        log: overrides.log ?? healthyLog,
      };
    },
    async active() {
      calls.active++;
      return { hosted: overrides.hosted ?? 60, box: overrides.box ?? 0 };
    },
  };
  return { box, calls };
};
// Planned minutes are 5 of setup plus each row's measured seconds: 15, 13, 10, 12 and 7.
const durations = {
  "declared:cloud a.spec.ts": 600,
  "declared:cloud b.spec.ts": 480,
  "declared:cloud c.spec.ts": 300,
  "declared:self-host d.spec.ts": 420,
  "declared:self-host e.spec.ts": 120,
};
const shardMatrices = (timeouts: Record<string, number> = {}): Matrices => {
  const row = (shard: string, runs: string) => ({ shard, runs, timeout: timeouts[shard] ?? 32 });
  return {
    "declared-cloud": {
      include: [
        row("declared-cloud-1", "declared:cloud a.spec.ts"),
        row("declared-cloud-2", "declared:cloud b.spec.ts"),
        row("declared-cloud-3", "declared:cloud c.spec.ts"),
      ],
    },
    "declared-self-host": {
      include: [
        row("declared-self-host-1", "declared:self-host d.spec.ts"),
        row("declared-self-host-2", "declared:self-host e.spec.ts"),
      ],
    },
  };
};
const selected = [
  "declared-cloud",
  "declared-self-host",
  "pool-runtime",
  "host-managed-accounts-pool",
  "catalog-compat",
  "client-desktop",
];
const input = (overrides: Partial<BoxInput> = {}): BoxInput => ({
  event: "push",
  ref: "refs/heads/batch/b123",
  attempt: "1",
  slots: "2",
  label: "basalt-box",
  selected,
  matrices: shardMatrices(),
  durations,
  ...overrides,
});
const route = (overrides: Partial<BoxInput> = {}, box = observer().box) =>
  routeBox(input(overrides), box, () => now, noWait);

test("box first: a healthy box fills its free slots with the longest shards", async () => {
  // 0 box jobs active: both slots take the two longest shards; hosted runs the other three.
  const routed = await route();
  assert.deepEqual(routed.jobs, ["declared-cloud-1", "declared-cloud-2"]);
  assert.equal(routed.label, "basalt-box");
  assert.equal(
    routed.summary,
    "Box routing: box first. 2 jobs go to the self-hosted runners (2 of 2 slots free) " +
      "because the box reported healthy with a CI budget of 2 (release slot busy); 3 run hosted, " +
      "while 60 hosted jobs are active elsewhere: declared-cloud-1, declared-cloud-2.",
  );
  for (const ref of ["refs/heads/main", "refs/heads/batch/b122"])
    assert.equal((await route({ ref })).jobs.length, 2, ref);
  const one = await route({}, observer({ box: 1 }).box);
  assert.deepEqual(one.jobs, ["declared-cloud-1"]);
  assert.match(
    one.summary,
    /box first\. 1 job goes to the self-hosted runners \(1 of 2 slots free\)/,
  );
  // The box's budget of 2 still bounds five configured slots.
  assert.equal((await route({ slots: "5" })).jobs.length, 2);
  assert.equal(
    (await route({ slots: "5" }, observer({ log: budgetLog({ ci_budget: 6 }) }).box)).jobs.length,
    5,
  );
});

test("the box's CI budget and BASALT_CI_BOX_SLOTS each cap the free slots", async () => {
  const cases: [string, string, Record<string, unknown>, number, RegExp][] = [
    [
      "budget below slots",
      "2",
      { ci_budget: 1 },
      0,
      /\(1 of 1 slots free\).*CI budget of 1 \(release slot busy\)/,
    ],
    [
      "slots below budget",
      "2",
      { ci_budget: 6, ci_budget_reason: "measured" },
      0,
      /\(2 of 2 slots free\).*CI budget of 6 \(measured\)/,
    ],
    ["budget less busy", "6", { ci_budget: 4 }, 1, /\(3 of 4 slots free\)/],
  ];
  for (const [name, slots, fields, box, summary] of cases) {
    const routed = await route({ slots }, observer({ log: budgetLog(fields), box }).box);
    assert.equal(
      routed.jobs.length,
      Math.min(Number(slots), fields.ci_budget as number) - box,
      name,
    );
    assert.match(routed.summary, summary, name);
  }
  const none: [string, Record<string, unknown>, RegExp][] = [
    ["zero", { ci_budget: 0, ci_budget_reason: "cpu pressure" }, /CI budget is 0 \(cpu pressure\)/],
    ["missing", { ci_budget: undefined }, /no whole-number CI budget/],
    ["fraction", { ci_budget: 1.5 }, /no whole-number CI budget/],
    ["string", { ci_budget: "2" }, /no whole-number CI budget/],
    ["negative", { ci_budget: -1 }, /no whole-number CI budget/],
    [
      "unhealthy",
      { healthy: false, ci_budget: 0, ci_budget_reason: "unhealthy" },
      /reported unhealthy \(unhealthy\)/,
    ],
  ];
  for (const [name, fields, why] of none) {
    const { box, calls } = observer({ log: budgetLog(fields) });
    const routed = await route({}, box);
    assert.deepEqual(routed.jobs, [], name);
    assert.equal(routed.label, "", name);
    assert.match(routed.summary, why, name);
    assert.deepEqual(calls, { heartbeat: 1, active: 0 }, name);
  }
  // The box's reason text reaches the summary as plain words only.
  assert.match(
    (
      await route(
        {},
        observer({ log: budgetLog({ ci_budget: 0, ci_budget_reason: "load `high` <b>" }) }).box,
      )
    ).summary,
    /CI budget is 0 \(load high b\)\.$/,
  );
});

test("a busy box routes nothing", async () => {
  for (const box of [2, 3]) {
    const { box: busy, calls } = observer({ box });
    const routed = await route({}, busy);
    assert.deepEqual(routed.jobs, [], String(box));
    assert.match(
      routed.summary,
      new RegExp(
        `because no box slot is free \\(${box} box jobs are active, 0 of 2 slots free, a CI budget of 2`,
      ),
    );
    assert.deepEqual(calls, { heartbeat: 1, active: 1 });
  }
});

test("box first: hosted's load never holds a shard back from a free box slot", async () => {
  for (const hosted of [0, 10, 25, 500])
    assert.deepEqual((await route({}, observer({ hosted }).box)).jobs, [
      "declared-cloud-1",
      "declared-cloud-2",
    ]);
  // With slots and budget to spare every shard that fits its timeout goes to the box.
  const roomy = observer({ hosted: 0, log: budgetLog({ ci_budget: 100 }) }).box;
  const all = await route({ slots: "100" }, roomy);
  assert.deepEqual(all.jobs, [
    "declared-cloud-1",
    "declared-cloud-2",
    "declared-self-host-1",
    "declared-cloud-3",
    "declared-self-host-2",
  ]);
  assert.match(all.summary, /; 0 run hosted/);
});

test("a shard that could pass its timeout at the slow end is skipped", async () => {
  // 15 × 2.0 = 30 overruns 29, so the next two longest go instead; 30 itself still fits.
  assert.deepEqual((await route({ matrices: shardMatrices({ "declared-cloud-1": 29 }) })).jobs, [
    "declared-cloud-2",
    "declared-self-host-1",
  ]);
  assert.deepEqual((await route({ matrices: shardMatrices({ "declared-cloud-1": 30 }) })).jobs, [
    "declared-cloud-1",
    "declared-cloud-2",
  ]);
  const tight = Object.fromEntries(
    [
      "declared-cloud-1",
      "declared-cloud-2",
      "declared-cloud-3",
      "declared-self-host-1",
      "declared-self-host-2",
    ].map((id) => [id, 13]),
  );
  const routed = await route({ matrices: shardMatrices(tight) });
  assert.deepEqual(routed.jobs, []);
  assert.match(
    routed.summary,
    /because no routable job fits its timeout at 2× its planned minutes/,
  );
  assert.equal(fitsTimeout({ id: "a", minutes: 10, timeout: Number.NaN }), false);
});

test("a stale, unhealthy, unmarked or unreadable heartbeat routes nothing", async () => {
  const cases: [string, ReturnType<typeof observer>["box"], RegExp][] = [
    ["stale", observer({ completedAt: minutesAgo(10.5) }).box, /older than 10 minutes/],
    ["future", observer({ completedAt: minutesAgo(-5) }).box, /older than 10 minutes/],
    ["no end", observer({ completedAt: "" }).box, /older than 10 minutes/],
    ["failed", observer({ conclusion: "failure" }).box, /heartbeat ended failure/],
    ["cancelled", observer({ conclusion: "cancelled" }).box, /heartbeat ended cancelled/],
    [
      "unhealthy",
      observer({ log: statusLine(minutesAgo(1), false, { ci_budget: 0 }) }).box,
      /reported unhealthy/,
    ],
    ["truthy", observer({ log: statusLine(minutesAgo(1), "true") }).box, /reported unhealthy/],
    [
      "no marker",
      observer({ log: JSON.stringify({ at: minutesAgo(1), healthy: true }) }).box,
      /no box status/,
    ],
    ["garbled", observer({ log: heartbeatMarker + "{healthy:true" }).box, /no box status/],
    ["no at", observer({ log: heartbeatMarker + '{"healthy":true}' }).box, /no box status/],
    ["old sample", observer({ log: statusLine(minutesAgo(4), true) }).box, /within 2 minutes/],
    ["bad sample", observer({ log: statusLine("yesterday", true) }).box, /within 2 minutes/],
    [
      "api error",
      {
        heartbeat: () => Promise.reject(new Error("GitHub returned 502")),
        active: () => Promise.resolve({ hosted: 99, box: 0 }),
      },
      /could not be read: GitHub returned 502/,
    ],
    [
      "load error",
      { heartbeat: observer().box.heartbeat, active: () => Promise.reject(new Error("no")) },
      /could not be read/,
    ],
  ];
  for (const [name, box, why] of cases) {
    const routed = await route({}, box);
    assert.deepEqual(routed.jobs, [], name);
    assert.match(routed.summary, why, name);
  }
  // Nine and a half minutes is still inside the window.
  const late = observer({ completedAt: minutesAgo(9.5), log: statusLine(minutesAgo(10), true) });
  assert.equal((await route({}, late.box)).jobs.length, 2);
  // The last marked line wins, so an older healthy sample can't vouch for a newer failure.
  const flipped = healthyLog + "\n" + statusLine(minutesAgo(1), false, { ci_budget: 0 });
  assert.deepEqual((await route({}, observer({ log: flipped }).box)).jobs, []);
});

test("this repository's pull requests route box first; a fork's never does", async () => {
  const own = { repository: "owner/repo", headRepository: "owner/repo" };
  for (const ref of ["refs/pull/1424/merge", "refs/heads/feature"])
    assert.deepEqual((await route({ event: "pull_request", ref, ...own })).jobs, [
      "declared-cloud-1",
      "declared-cloud-2",
    ]);
  // A fork's code is not this repository's: no variable or box state lets it route.
  for (const heads of [
    { repository: "owner/repo", headRepository: "fork/repo" },
    { repository: "owner/repo", headRepository: "Owner/Repo-fork" },
    { repository: "owner/repo", headRepository: undefined },
    { repository: "owner/repo", headRepository: "" },
    { repository: undefined, headRepository: undefined },
    { repository: "", headRepository: "" },
  ]) {
    const { box, calls } = observer();
    const routed = await route(
      { event: "pull_request", ref: "refs/pull/1/merge", slots: "100", ...heads },
      box,
    );
    assert.deepEqual(routed.jobs, [], JSON.stringify(heads));
    assert.match(routed.summary, /fork pull requests never run on the self-hosted runners/);
    assert.deepEqual(calls, { heartbeat: 0, active: 0 });
  }
  // A re-run of a pull request's Check still runs hosted.
  assert.match(
    (await route({ event: "pull_request", ref: "refs/pull/1/merge", attempt: "2", ...own }))
      .summary,
    /a re-run always runs hosted/,
  );
  for (const [event, ref] of [
    ["pull_request_target", "refs/heads/main"],
    ["workflow_dispatch", "refs/heads/main"],
    ["push", "refs/heads/feature"],
    ["push", "refs/tags/v1"],
    ["push", "refs/heads/batchy"],
  ])
    assert.deepEqual((await route({ event, ref })).jobs, [], event + " " + ref);
});

test("unset, zero or malformed variables route nothing", async () => {
  for (const slots of [undefined, "", "0", "-1", "1.5", "03", "two", "1000"]) {
    const { box, calls } = observer();
    const routed = await route({ slots }, box);
    assert.deepEqual(routed.jobs, [], String(slots));
    assert.match(routed.summary, /BASALT_CI_BOX_SLOTS/);
    assert.deepEqual(calls, { heartbeat: 0, active: 0 });
  }
  for (const label of [
    undefined,
    "",
    "self-hosted",
    "basalt-release",
    "Basalt-Release",
    "linux",
    "X64",
    "ARM64",
    "a b",
  ])
    assert.match((await route({ label })).summary, /BASALT_CI_BOX_LABEL/, String(label));
  // "Re-run failed jobs" reuses select's outputs, so only a first attempt may route at all.
  for (const attempt of [undefined, "", "2", "10"]) {
    const { box, calls } = observer();
    const routed = await route({ attempt }, box);
    assert.deepEqual(routed.jobs, [], String(attempt));
    assert.match(routed.summary, /a re-run always runs hosted/);
    assert.deepEqual(calls, { heartbeat: 0, active: 0 });
  }
  assert.equal(typeof boxSettings(input()), "object");
});

/** Every box_jobs id a named job can take: its own name, or one id per matrix leg. */
const namedIds = Object.entries(namedJobs).flatMap(([job, { minutes }]) =>
  typeof minutes === "number" ? [job] : Object.keys(minutes).map((leg) => `${job}:${leg}`),
);

test("declared shard rows and benched named jobs route, and free slots and timeouts bound the real plan", async () => {
  const routable = [...declaredJobs, ...Object.keys(namedJobs)];
  for (const job of [...heavyJobs, ...fastJobs])
    assert.equal(
      routedJob(job),
      typeof namedJobs[job]?.minutes === "number" ? job : undefined,
      job,
    );
  const real = declaredMatrices();
  // The fast lane's jobs run in every Check, so select passes them with the selected heavy jobs.
  const everyJob = [...fastJobs, ...heavyJobs];
  const plan = checkPlan(everyJob, real);
  assert.deepEqual(
    plan.shards.map((shard) => shard.id).sort(),
    [
      ...declaredJobs.flatMap((job) => real[job]!.include.map((row) => row.shard)),
      ...namedIds,
    ].sort(),
  );
  for (const shard of plan.shards) assert.ok(routable.includes(routedJob(shard.id)!), shard.id);
  const { box, calls } = observer();
  const none = await routeBox(
    input({ selected: heavyJobs.filter((job) => !routable.includes(job)) }),
    box,
    () => now,
    noWait,
  );
  assert.deepEqual(none.jobs, []);
  assert.match(none.summary, /runs no job the box can take/);
  assert.deepEqual(calls, { heartbeat: 0, active: 0 });
  const fitting = plan.shards.filter(fitsTimeout).sort((a, b) => b.minutes - a.minutes);
  for (const slots of [1, 2, 3, 5])
    for (const busy of [0, 1, 2]) {
      const routed = await routeBox(
        input({ slots: String(slots), selected: everyJob, matrices: real, durations: undefined }),
        observer({ hosted: 500, box: busy, log: budgetLog({ ci_budget: 3 }) }).box,
        () => now,
        noWait,
      );
      const free = Math.max(0, Math.min(slots, 3) - busy);
      assert.equal(routed.jobs.length, Math.min(free, fitting.length), `${slots}/${busy}`);
      assert.deepEqual(
        routed.jobs.map((id) => plan.shards.find((shard) => shard.id === id)!.minutes),
        fitting.slice(0, routed.jobs.length).map((shard) => shard.minutes),
        `${slots}/${busy}`,
      );
    }
  assert.equal(boxSlowdown, 2);
  assert.deepEqual(fillBox([{ id: "a", minutes: 31, timeout: 61 }], 5), []);
  assert.deepEqual(
    fillBox(
      [
        { id: "a", minutes: 5, timeout: 30 },
        { id: "b", minutes: 4, timeout: 30 },
      ],
      1,
    ),
    ["a"],
  );
  assert.deepEqual(fillBox([{ id: "a", minutes: 5, timeout: 30 }], 0), []);
});

test("shard rows carry their planned minutes; unknown files take their group's median", () => {
  const plan = checkPlan(
    ["declared-cloud", "neon-key-reuse", "pool-inventory", "client-desktop"],
    {
      "declared-cloud": {
        include: [
          {
            shard: "declared-cloud-1",
            runs: "declared:cloud a.spec.ts declared:cloud b.spec.ts",
            timeout: 33,
          },
          { shard: "declared-cloud-2", runs: "declared:cloud new.spec.ts", timeout: 29 },
        ],
      },
    },
    {
      "declared:cloud a.spec.ts": 300,
      "declared:cloud b.spec.ts": 180,
      "declared:cloud c.spec.ts": 60,
    },
  );
  assert.deepEqual(plan, {
    shards: [
      { id: "declared-cloud-1", minutes: 13, timeout: 33 },
      { id: "declared-cloud-2", minutes: 8, timeout: 29 },
    ],
  });
  for (const id of ["declared-cloud-1", "declared-self-host-12", "declared-local-1"])
    assert.ok(declaredJobs.includes(routedJob(id)!), id);
  for (const id of ["declared-cloud", "declared-cloud-x", "pool-runtime", "unknown"])
    assert.equal(routedJob(id), undefined, id);
});

test("the REST observer trusts only the box's own heartbeat and counts hosted and box jobs in one pass", async () => {
  const requests: { url: string; authorization: string }[] = [];
  const job = (status: string, labels: string[], group: string | null = null) => ({
    status,
    labels,
    runner_group_name: group,
  });
  const own = { full_name: "owner/repo" };
  const heartbeatRun = (
    id: number,
    event: string,
    repository = own,
    fields: Record<string, unknown> = {},
  ) => ({
    id,
    event,
    path: heartbeatPath,
    head_repository: repository,
    head_branch: "main",
    conclusion: "success",
    updated_at: minutesAgo(1),
    ...fields,
  });
  const heartbeatRuns = "/actions/workflows/box-heartbeat.yml/runs?status=completed&per_page=50";
  const boxJob = (id: number, labels = ["basalt-box"]) => ({
    jobs: [{ id, labels, conclusion: "success", completed_at: minutesAgo(1) }],
  });
  const routes: Record<string, unknown> = {
    // Newest first: a cancelled Check-start run, a dispatch on another branch, a pull-request run
    // and a fork run of the same file, then a run whose job didn't run on the box, then the box's
    // real heartbeat.
    [heartbeatRuns]: {
      workflow_runs: [
        heartbeatRun(12, "workflow_run", own, { conclusion: "cancelled" }),
        heartbeatRun(10, "workflow_dispatch", own, { head_branch: "feature" }),
        heartbeatRun(9, "pull_request"),
        heartbeatRun(8, "schedule", { full_name: "fork/repo" }),
        heartbeatRun(7, "workflow_dispatch"),
        heartbeatRun(6, "schedule"),
      ],
    },
    "/actions/runs/9/jobs?filter=latest&per_page=50&page=1": boxJob(90),
    "/actions/runs/8/jobs?filter=latest&per_page=50&page=1": boxJob(80),
    "/actions/runs/7/jobs?filter=latest&per_page=50&page=1": boxJob(70, ["ubuntu-latest"]),
    "/actions/runs/6/jobs?filter=latest&per_page=50&page=1": boxJob(60, ["Basalt-Box"]),
    "/actions/jobs/60/logs": healthyLog,
    "/actions/runs?status=in_progress&per_page=50&page=1": {
      workflow_runs: [
        { id: 1, path: ".github/workflows/ci.yml" },
        { id: 99, path: ".github/workflows/ci.yml" },
        heartbeatRun(5, "schedule"),
        // Another workflow's run never holds a box job, so its jobs are never listed.
        { id: 3, path: ".github/workflows/app-conventions.yml" },
      ],
    },
    "/actions/runs?status=queued&per_page=50&page=1": {
      workflow_runs: [{ id: 2, path: ".github/workflows/ci.yml@refs/pull/7/merge" }],
    },
    "/actions/runs/1/jobs?filter=latest&per_page=50&page=1": {
      jobs: [
        job("in_progress", ["ubuntu-latest"], "GitHub Actions"),
        job("queued", ["ubuntu-latest"]),
        job("completed", ["ubuntu-latest"], "GitHub Actions"),
        job("in_progress", ["basalt-box"], "Default"),
        job("completed", ["basalt-box"], "Default"),
        job("in_progress", ["ubuntu-latest"], "Default"),
        // Release-label jobs hold neither a CI slot nor a hosted runner.
        job("queued", ["self-hosted", "basalt-release"]),
        job("in_progress", ["basalt-release"], "Default"),
      ],
    },
    "/actions/runs/2/jobs?filter=latest&per_page=50&page=1": {
      // A queued box job holds a slot just like a running one, whatever its label's case.
      jobs: [
        job("queued", ["windows-latest"]),
        job("waiting", ["ubuntu-latest"]),
        job("queued", ["Basalt-Box"]),
      ],
    },
    // The heartbeat's own job in flight doesn't hold a CI slot.
    "/actions/runs/5/jobs?filter=latest&per_page=50&page=1": {
      jobs: [job("in_progress", ["basalt-box"], "Default")],
    },
  };
  const fetcher = async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.test/repos/owner/repo", "");
    requests.push({ url: path, authorization: new Headers(init.headers).get("authorization")! });
    if (!(path in routes)) return new Response("missing", { status: 404 });
    const body = routes[path];
    return new Response(typeof body === "string" ? body : JSON.stringify(body));
  };
  const env = {
    api: "https://api.test",
    repository: "owner/repo",
    token: "t",
    runId: "99",
    label: "basalt-box",
  };
  const box = githubObserver(env, fetcher);
  assert.deepEqual(await box.heartbeat(), {
    conclusion: "success",
    completedAt: minutesAgo(1),
    log: healthyLog,
  });
  // Cancelled and untrusted runs are skipped before their jobs or logs are read.
  for (const id of [12, 10, 9, 8])
    assert.ok(!requests.some((r) => r.url.startsWith(`/actions/runs/${id}/`)));
  assert.ok(!requests.some((r) => r.url === "/actions/jobs/70/logs"));
  assert.deepEqual(await box.active(), { hosted: 3, box: 2 });
  assert.ok(requests.every((request) => request.authorization === "Bearer t"));
  // This Check's own run is counted from its selection, never from the API.
  assert.ok(!requests.some((request) => request.url.startsWith("/actions/runs/99/")));
  assert.ok(!requests.some((request) => request.url.startsWith("/actions/runs/5/")));
  assert.ok(!requests.some((request) => request.url.startsWith("/actions/runs/3/")));
  // The box's budget of 2 is held by the two box jobs.
  const busy = await routeBox(input({ slots: "3" }), box, () => now, noWait);
  assert.deepEqual(busy.jobs, []);
  assert.match(busy.summary, /no box slot is free \(2 box jobs are active, 0 of 2 slots free/);
  routes["/actions/jobs/60/logs"] = "2026-11-19T11:59:00.0000000Z " + budgetLog({ ci_budget: 6 });
  const routed = await routeBox(input({ slots: "3" }), box, () => now, noWait);
  assert.deepEqual(routed.jobs, ["declared-cloud-1"]);
  assert.match(routed.summary, /while 3 hosted jobs are active elsewhere/);

  delete routes["/actions/runs?status=queued&per_page=50&page=1"];
  const failed = await routeBox(input(), githubObserver(env, fetcher), () => now, noWait);
  assert.deepEqual(failed.jobs, []);
  assert.match(failed.summary, /GitHub returned 404 for \/actions\/runs/);
  // With only untrusted or off-box runs left, nothing vouches for the box.
  for (const runs of [
    [heartbeatRun(9, "pull_request")],
    [heartbeatRun(8, "schedule", { full_name: "fork/repo" })],
    [heartbeatRun(7, "workflow_dispatch")],
    [heartbeatRun(10, "workflow_dispatch", own, { head_branch: "feature" })],
    [heartbeatRun(13, "schedule", own, { head_branch: "feature" })],
    [heartbeatRun(12, "workflow_run", own, { conclusion: "cancelled" })],
    [{ ...heartbeatRun(4, "schedule"), path: ".github/workflows/ci.yml" }],
    [],
  ]) {
    routes[heartbeatRuns] = { workflow_runs: runs };
    await assert.rejects(
      githubObserver(env, fetcher).heartbeat(),
      /no completed heartbeat run from the box/,
    );
    const none = await routeBox(input(), githubObserver(env, fetcher), () => now, noWait);
    assert.deepEqual(none.jobs, []);
  }
  // A Check's start triggers a heartbeat from the default branch's file: trusted whatever branch
  // started the Check.
  routes[heartbeatRuns] = {
    workflow_runs: [heartbeatRun(11, "workflow_run", own, { head_branch: "feature" })],
  };
  routes["/actions/runs/11/jobs?filter=latest&per_page=50&page=1"] = boxJob(110);
  routes["/actions/jobs/110/logs"] = healthyLog;
  assert.deepEqual(await githubObserver(env, fetcher).heartbeat(), {
    conclusion: "success",
    completedAt: minutesAgo(1),
    log: healthyLog,
  });
  // A failed heartbeat still stops routing; only a cancelled one is passed over.
  routes[heartbeatRuns] = {
    workflow_runs: [
      heartbeatRun(14, "workflow_run", own, { conclusion: "failure" }),
      heartbeatRun(11, "workflow_run"),
    ],
  };
  assert.equal((await githubObserver(env, fetcher).heartbeat()).conclusion, "failure");
});

test("a stale heartbeat waits for the one this Check's start triggered, then gives up", async () => {
  let reads = 0;
  const waits: number[] = [];
  const freshAfter = (fresh: number): BoxObserver => ({
    async heartbeat() {
      reads++;
      return {
        conclusion: "success",
        completedAt: reads > fresh ? minutesAgo(0) : minutesAgo(30),
        log: budgetLog({ ci_budget: 6 }),
      };
    },
    async active() {
      return { hosted: 0, box: 0 };
    },
  });
  const wait = async (ms: number) => {
    waits.push(ms);
  };
  const routed = await routeBox(input(), freshAfter(2), () => now, wait);
  assert.deepEqual(routed.jobs, ["declared-cloud-1", "declared-cloud-2"]);
  assert.deepEqual(waits, [15_000, 15_000]);
  reads = 0;
  waits.length = 0;
  const stale = await routeBox(input(), freshAfter(99), () => now, wait);
  assert.deepEqual(stale.jobs, []);
  assert.match(stale.summary, /older than 10 minutes/);
  assert.equal(waits.length, 4);
  // A fresh heartbeat never waits.
  reads = 0;
  waits.length = 0;
  await routeBox(input(), freshAfter(0), () => now, wait);
  assert.deepEqual(waits, []);
});

// A re-run reuses select's outputs, so only the first attempt may use them; the label is the one
// select validated, never the variable read again at job time.
const shardExpression =
  "${{ github.run_attempt == 1 && contains(fromJSON(needs.select.outputs.box_jobs), matrix.shard) && needs.select.outputs.box_label || 'ubuntu-latest' }}";

const namedExpression = (key: string) =>
  `\${{ github.run_attempt == 1 && contains(fromJSON(needs.select.outputs.box_jobs), ${key}) && needs.select.outputs.box_label || 'ubuntu-latest' }}`;

test("declared shard jobs and benched named jobs use the router expression; every other job runs hosted", () => {
  for (const id of declaredJobs) {
    assert.ok(heavyJobs.includes(id), id);
    assert.equal(workflow.jobs[id]["runs-on"], shardExpression, id);
    assert.equal(workflow.jobs[id].name, "${{ matrix.shard }}", id);
    assert.ok(workflow.jobs.check.needs.includes(id), id);
  }
  for (const [id, { minutes, timeout }] of Object.entries(namedJobs)) {
    const job = workflow.jobs[id];
    assert.ok(heavyJobs.includes(id) || fastJobs.includes(id), id);
    assert.ok(workflow.jobs.check.needs.includes(id), id);
    assert.ok([job.needs].flat().includes("select"), id);
    // The table's timeout is the job's own, which every named job sets: a hung job would hold a
    // box slot for as long as it is allowed to run.
    assert.equal(job["timeout-minutes"], timeout, id);
    if (typeof minutes === "number") {
      assert.equal(job["runs-on"], namedExpression(`'${id}'`), id);
      assert.equal(job.strategy, undefined, id);
    } else {
      // Matrix legs route one by one, under the leg names the workflow's matrix declares.
      assert.equal(job["runs-on"], namedExpression(`format('${id}:{0}', matrix.scope)`), id);
      assert.deepEqual(
        job.strategy.matrix.include.map((row: { scope: string }) => row.scope).sort(),
        Object.keys(minutes).sort(),
        id,
      );
    }
  }
  for (const [id, job] of Object.entries<{ "runs-on": string; strategy?: { matrix?: unknown } }>(
    workflow.jobs,
  )) {
    if (declaredJobs.includes(id) || id in namedJobs) continue;
    assert.equal(
      job["runs-on"],
      id === "client-desktop" ? "${{ matrix.os }}" : "ubuntu-latest",
      id,
    );
  }
  assert.ok(!read(".github/workflows/ci.yml").includes("scripts/ci/job-durations.json"));
});

test("a named job routes by its exact id, and the gate accepts it only when the job is selected", () => {
  assert.equal(routedJob("production-ops-identity:credentials"), "production-ops-identity");
  assert.equal(routedJob("client-connection"), "client-connection");
  for (const invalid of [
    "production-ops-identity",
    "production-ops-identity:nope",
    "production-ops-identity:credentials:x",
    "client-connection:credentials",
    "client-mobile",
    // Benched jobs only: one without a green single in its Checks' floor stays hosted.
    "fast",
    "host-managed-accounts-local",
    ":credentials",
  ])
    assert.equal(routedJob(invalid), undefined, invalid);
  // Every named row fits its timeout at the slow end, so the table never lists a dead row.
  for (const shard of checkPlan(Object.keys(namedJobs), {}).shards)
    assert.ok(fitsTimeout(shard), shard.id);
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...conditionalJobs].map((id) => [
      id,
      { result: conditionalJobs.includes(id) && id !== "workerd-assets" ? "skipped" : "success" },
    ]),
  );
  assert.deepEqual(gateErrors(needs, heavyJobs, namedIds, true), []);
  const without = heavyJobs.filter((job) => job !== "production-ops-identity");
  assert.ok(
    gateErrors(needs, without, ["production-ops-identity:credentials"]).includes(
      "Invalid box-job selection",
    ),
  );
  // The fast lane's jobs run in every Check, so the gate takes them on the box with no heavy job.
  assert.ok(
    !gateErrors(needs, [], ["browser-install", "client-connection"]).includes(
      "Invalid box-job selection",
    ),
  );
});

test("no workflow names the box or release runner labels outside the heartbeat's default", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
    const document = parse(readFileSync(new URL(file, directory), "utf8"));
    for (const [id, job] of Object.entries<{ "runs-on"?: unknown }>(document.jobs ?? {})) {
      const runsOn = JSON.stringify(job["runs-on"] ?? "");
      if (file === "box-heartbeat.yml") continue;
      assert.doesNotMatch(runsOn, /basalt-box|basalt-release|self-hosted/i, file + " " + id);
    }
  }
  const source = read(".github/workflows/ci.yml");
  assert.doesNotMatch(source, /boat|BASALT_CI_RUNNER_HEAVY|basalt-box|basalt-release/i);
});

test("select reads only the routing inputs it needs, and the aggregate holds every routed job", () => {
  const select = workflow.jobs.select;
  assert.deepEqual(select.permissions, { contents: "read", actions: "read" });
  assert.equal(select.outputs.box_jobs, "${{ steps.jobs.outputs.box_jobs }}");
  assert.equal(select.outputs.box_label, "${{ steps.jobs.outputs.box_label }}");
  assert.equal(select.outputs.hosted_jobs, undefined);
  assert.equal(select.steps[0].uses, "actions/checkout@v4");
  assert.deepEqual(select.steps[0].with, { "fetch-depth": 0, "persist-credentials": false });
  for (const [id, job] of Object.entries<{ "runs-on": string }>(workflow.jobs))
    assert.doesNotMatch(job["runs-on"], /vars\./, id);
  const step = select.steps.find((candidate: { id?: string }) => candidate.id === "jobs");
  assert.equal(step.env.BOX_SLOTS, "${{ vars.BASALT_CI_BOX_SLOTS }}");
  assert.equal(step.env.BOX_LABEL, "${{ vars.BASALT_CI_BOX_LABEL }}");
  assert.equal(step.env.HOSTED_CAP, undefined);
  assert.equal(step.env.HEAD_REPOSITORY, "${{ github.event.pull_request.head.repo.full_name }}");
  // A fork's pull request gets no token, so it can't even read the box's state.
  assert.equal(
    step.env.GITHUB_TOKEN,
    "${{ (github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository) && github.token || '' }}",
  );
  const gate = workflow.jobs.check.steps.find(
    (candidate: { id?: string }) => candidate.id === "gate",
  );
  assert.equal(gate.env.CI_BOX_JOBS, "${{ needs.select.outputs.box_jobs }}");

  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...conditionalJobs].map((id) => [
      id,
      { result: conditionalJobs.includes(id) && id !== "workerd-assets" ? "skipped" : "success" },
    ]),
  );
  const box = ["declared-cloud-3", "declared-self-host-1"];
  assert.deepEqual(gateErrors(needs, heavyJobs, box, true), []);
  for (const id of ["declared-self-host", "declared-cloud"])
    for (const result of ["failure", "cancelled", "skipped"])
      assert.ok(
        gateErrors({ ...needs, [id]: { result } }, heavyJobs, box, true).some((error) =>
          error.startsWith(id + ":"),
        ),
        `${id}: ${result}`,
      );
  for (const invalid of [
    ["client-desktop"],
    // The fast lane's routing and gate jobs stay hosted.
    ["select"],
    ["long-started"],
    ["pool-runtime"],
    ["declared-cloud"],
    ["declared-cloud-1", "declared-cloud-1"],
    ["x"],
  ])
    assert.ok(
      gateErrors(needs, heavyJobs, invalid, true).includes("Invalid box-job selection"),
      invalid.join(),
    );
  assert.ok(
    gateErrors(needs, ["production-build"], ["declared-cloud-1"]).includes(
      "Invalid box-job selection",
    ),
  );
});

test("the heartbeat runs on the box with no checkout, no secrets and no permissions", () => {
  assert.deepEqual(heartbeatWorkflow.on, {
    workflow_run: { workflows: ["Check"], types: ["requested"] },
    schedule: [{ cron: "*/5 * * * *" }],
    workflow_dispatch: null,
  });
  // The Check workflow it follows is this repository's own.
  assert.equal(workflow.name, "Check");
  assert.deepEqual(heartbeatWorkflow.permissions, {});
  assert.deepEqual(heartbeatWorkflow.concurrency, {
    group: "box-heartbeat",
    "cancel-in-progress": true,
  });
  const jobs = Object.values<Record<string, unknown>>(heartbeatWorkflow.jobs);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job!["runs-on"], "${{ vars.BASALT_CI_BOX_LABEL || 'basalt-box' }}");
  assert.equal(job!["timeout-minutes"], 2);
  assert.equal(job!.permissions, undefined);
  const steps = job!.steps as { uses?: string; run?: string; env?: unknown; with?: unknown }[];
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.uses, undefined);
  assert.equal(steps[0]!.env, undefined);
  assert.doesNotMatch(heartbeatSource, /secrets\.|github\.token|checkout/);
  const run = steps[0]!.run!;
  assert.ok(run.includes(`printf '${heartbeatMarker}%s\\n' "$status"\n`));
  assert.ok(run.includes(`printf '${heartbeatMarker}%s\\n' "$status" >> "$GITHUB_STEP_SUMMARY"`));
  // The whole status object is printed on one line.
  assert.ok(
    run.includes(`status="$(head -c 4096 /opt/basalt-health/status.json | tr -d '\\r\\n')"`),
  );
});

test("the real selector routes nothing outside a configured push and keeps the old routing gone", () => {
  for (const env of [
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/1/merge",
      BOX_SLOTS: "9",
      BOX_LABEL: "basalt-box",
    },
    {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      BOX_SLOTS: "",
      BOX_LABEL: "basalt-box",
    },
    {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      BOX_SLOTS: "0",
      BOX_LABEL: "basalt-box",
    },
  ]) {
    const scratch = mkdtempSync(join(tmpdir(), "basalt-box-router-"));
    const output = join(scratch, "output");
    const result = spawnSync(process.execPath, ["scripts/ci/select-jobs.ts", "--all"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_TOKEN: "",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    // Nothing routed, so runs-on gets no label.
    const lines = readFileSync(output, "utf8").split("\n");
    rmSync(scratch, { recursive: true, force: true });
    assert.ok(lines.includes("box_jobs=[]") && lines.includes("box_label="));
    const selected = JSON.parse(result.stdout);
    assert.deepEqual(selected.jobs, heavyJobs);
    assert.deepEqual(selected.boxJobs, []);
    assert.match(selected.boxRouting, /^Box routing: every job runs hosted/);
    assert.equal(selected.boatJobs, undefined);
    assert.equal(selected.hostedJobs, undefined);
  }
});

test("pool fixture networking is scoped to self-hosted runners and checked before the contracts", () => {
  const steps = workflow.jobs["pool-runtime"].steps;
  const firewall = steps.findIndex(
    (step: { name?: string }) =>
      step.name === "Allow pool fixture HTTP from Docker bridges on self-hosted runners",
  );
  const probe = steps.findIndex(
    (step: { name?: string }) =>
      step.name === "Verify containers can reach the host fixture listeners",
  );
  const contracts = steps.findIndex(
    (step: { name?: string }) => step.name === "Check the pool runtime and database contracts",
  );
  assert.equal(steps[firewall].if, "runner.environment == 'self-hosted'");
  assert.deepEqual(steps[firewall].run.trim().split("\n"), [
    "sudo iptables -I INPUT 1 -i docker0 -p tcp -j ACCEPT",
    "sudo iptables -I INPUT 1 -i br+ -p tcp -j ACCEPT",
  ]);
  assert.ok(firewall < probe && probe < contracts);
  assert.equal(steps[probe].if, undefined);
  assert.equal(steps[probe].run, "node scripts/ci/check-docker-host.mjs basalt-1409-pool:test");
  assert.match(steps[contracts].run, /pool-test-shard\.ts "\$POOL_TEST_SHARD"/);
  assert.match(steps[contracts].run, /^node --test --test-concurrency=1 "\$\{files\[@\]\}"$/m);
});

test("signed migration proofs stay hosted with both bounded adoption shards", () => {
  const job = workflow.jobs["production-ops-migrations"];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 25);
  const adoption = job.steps.filter((step: { run?: string }) =>
    step.run?.startsWith("node scripts/production-ops/prove-provider-adoption.ts"),
  );
  assert.equal(adoption.length, 2);
  for (const shard of [1, 2]) {
    const step = job.steps.find(
      (step: { name?: string }) =>
        step.name === `Verify provider account adoption through signed operations, shard ${shard}`,
    );
    assert.equal(step["timeout-minutes"], 5);
    assert.equal(
      step.run,
      `node scripts/production-ops/prove-provider-adoption.ts --shard ${shard}/2`,
    );
  }
  const migrations = job.steps.find(
    (step: { name?: string }) =>
      step.name === "Verify migration ownership through signed apply verification and replay",
  );
  assert.equal(migrations["timeout-minutes"], 5);
  assert.equal(
    migrations.run,
    'BASALT_SCOPE_PROOF_PATTERN="$(node scripts/ci/e2e-pattern.ts production-ops:migrations)" node scripts/production-ops/prove-scope.ts',
  );
});
