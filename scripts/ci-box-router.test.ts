import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  matrixLegs,
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
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const statusLine = (at: string, healthy: unknown) =>
  heartbeatMarker +
  JSON.stringify({ at, load1: 3.1, ci_slots: 2, ci_busy: 1, release_busy: 0, healthy });
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
  "account-acquisition",
  "client-desktop",
];
const input = (overrides: Partial<BoxInput> = {}): BoxInput => ({
  event: "push",
  ref: "refs/heads/batch/b123",
  slots: "2",
  label: "basalt-box",
  selected,
  matrices: shardMatrices(),
  durations,
  fixedJobs: 4,
  ...overrides,
});
const route = (overrides: Partial<BoxInput> = {}, box = observer().box) =>
  routeBox(input(overrides), box, () => now);

test("a healthy box with hosted over its cap fills its free slots with the longest shards", async () => {
  // 0 box jobs active and 35 jobs over the hosted cap: both slots take the two longest shards.
  const routed = await route();
  assert.deepEqual(routed.jobs, ["declared-cloud-1", "declared-cloud-2"]);
  // 4 fast-lane jobs, 5 shards, pool-runtime's 2 legs, 2 single jobs and 2 desktop legs.
  assert.equal(
    routed.summary,
    "Box routing: 2 declared shards go to the self-hosted runners (2 of 2 slots free) because " +
      "the box reported healthy and 60 hosted jobs are active and this Check adds 15, against a " +
      "cap of 40: declared-cloud-1, declared-cloud-2.",
  );
  for (const ref of ["refs/heads/main", "refs/heads/batch/b122"])
    assert.equal((await route({ ref })).jobs.length, 2, ref);
  const one = await route({}, observer({ box: 1 }).box);
  assert.deepEqual(one.jobs, ["declared-cloud-1"]);
  assert.match(one.summary, /\(1 of 2 slots free\)/);
  assert.deepEqual((await route({ slots: "5" })).jobs.length, 5);
});

test("a busy box routes nothing", async () => {
  for (const box of [2, 3]) {
    const { box: busy, calls } = observer({ box });
    const routed = await route({}, busy);
    assert.deepEqual(routed.jobs, [], String(box));
    assert.match(
      routed.summary,
      new RegExp(`because no box slot is free \\(${box} box jobs are active, 0 of 2 slots free\\)`),
    );
    assert.deepEqual(calls, { heartbeat: 1, active: 1 });
  }
});

test("routing never takes more shards than hosted is over its cap", async () => {
  // 28 hosted plus 15 own is 3 over 40.
  assert.deepEqual((await route({ slots: "100" }, observer({ hosted: 28 }).box)).jobs, [
    "declared-cloud-1",
    "declared-cloud-2",
    "declared-self-host-1",
  ]);
  // One over the cap with both slots free routes one.
  assert.deepEqual((await route({ hostedCap: "42" }, observer({ hosted: 28 }).box)).jobs, [
    "declared-cloud-1",
  ]);
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
    /because no declared shard fits its timeout at 2× its planned minutes/,
  );
  assert.equal(fitsTimeout({ id: "a", minutes: 10, timeout: Number.NaN }), false);
});

test("hosted under its cap routes nothing", async () => {
  for (const hosted of [0, 10, 25]) {
    const routed = await route({}, observer({ hosted }).box);
    assert.deepEqual(routed.jobs, [], String(hosted));
    assert.match(routed.summary, /^Box routing: every job runs hosted, because \d+ hosted jobs/);
  }
});

test("a stale, unhealthy, unmarked or unreadable heartbeat routes nothing", async () => {
  const cases: [string, ReturnType<typeof observer>["box"], RegExp][] = [
    ["stale", observer({ completedAt: minutesAgo(10.5) }).box, /older than 10 minutes/],
    ["future", observer({ completedAt: minutesAgo(-5) }).box, /older than 10 minutes/],
    ["no end", observer({ completedAt: "" }).box, /older than 10 minutes/],
    ["failed", observer({ conclusion: "failure" }).box, /heartbeat ended failure/],
    ["cancelled", observer({ conclusion: "cancelled" }).box, /heartbeat ended cancelled/],
    ["unhealthy", observer({ log: statusLine(minutesAgo(1), false) }).box, /reported unhealthy/],
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
  const flipped = healthyLog + "\n" + statusLine(minutesAgo(1), false);
  assert.deepEqual((await route({}, observer({ log: flipped }).box)).jobs, []);
});

test("pull requests never route, whatever the variables and the box say", async () => {
  // The box runs jobs in privileged containers on a host that also runs release work, so
  // unmerged pull-request code must not run there until the CI slots are isolated.
  for (const ref of ["refs/pull/1424/merge", "refs/heads/main", "refs/heads/batch/b1"]) {
    const { box, calls } = observer();
    const routed = await route({ event: "pull_request", ref, slots: "100" }, box);
    assert.deepEqual(routed.jobs, []);
    assert.match(routed.summary, /pull requests never run on the self-hosted runners/);
    assert.deepEqual(calls, { heartbeat: 0, active: 0 });
  }
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
  for (const label of [undefined, "", "self-hosted", "basalt-release", "Basalt-Release", "a b"])
    assert.match((await route({ label })).summary, /BASALT_CI_BOX_LABEL/, String(label));
  for (const hostedCap of ["-1", "x", "4.5"])
    assert.match((await route({ hostedCap })).summary, /BASALT_CI_HOSTED_CAP/, hostedCap);
  assert.equal(typeof boxSettings({ ...input(), hostedCap: "" }), "object");
});

test("only declared shard rows can route, and free slots and timeouts bound the real plan", async () => {
  // Every job type ran slower on the box; shards need the fewest cores and fill its slots.
  for (const job of [...heavyJobs, ...fastJobs]) assert.equal(routedJob(job), undefined, job);
  const real = declaredMatrices();
  const plan = checkPlan(heavyJobs, real);
  assert.deepEqual(
    plan.shards.map((shard) => shard.id).sort(),
    declaredJobs.flatMap((job) => real[job]!.include.map((row) => row.shard)).sort(),
  );
  for (const shard of plan.shards) assert.ok(declaredJobs.includes(routedJob(shard.id)!), shard.id);
  const { box, calls } = observer();
  const none = await routeBox(
    input({ selected: heavyJobs.filter((job) => !declaredJobs.includes(job)) }),
    box,
    () => now,
  );
  assert.deepEqual(none.jobs, []);
  assert.match(none.summary, /runs no declared e2e shards/);
  assert.deepEqual(calls, { heartbeat: 0, active: 0 });
  const fitting = plan.shards.filter(fitsTimeout).sort((a, b) => b.minutes - a.minutes);
  for (const slots of [1, 2, 3, 5])
    for (const busy of [0, 1, 2]) {
      const routed = await routeBox(
        input({ slots: String(slots), selected: heavyJobs, matrices: real, durations: undefined }),
        observer({ hosted: 500, box: busy }).box,
        () => now,
      );
      const free = Math.max(0, slots - busy);
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
    jobs: 8,
  });
  for (const id of ["declared-cloud-1", "declared-self-host-12", "declared-local-1"])
    assert.ok(declaredJobs.includes(routedJob(id)!), id);
  for (const id of ["declared-cloud", "declared-cloud-x", "pool-runtime", "unknown"])
    assert.equal(routedJob(id), undefined, id);
});

test("the REST observer reads the newest heartbeat log and counts hosted and box jobs in one pass", async () => {
  const requests: { url: string; authorization: string }[] = [];
  const job = (status: string, labels: string[], group: string | null = null) => ({
    status,
    labels,
    runner_group_name: group,
  });
  const routes: Record<string, unknown> = {
    "/actions/workflows/box-heartbeat.yml/runs?branch=main&status=completed&per_page=1": {
      workflow_runs: [{ id: 7, conclusion: "success", updated_at: minutesAgo(1) }],
    },
    "/actions/runs/7/jobs?filter=latest&per_page=100&page=1": {
      jobs: [{ id: 70, conclusion: "success", completed_at: minutesAgo(1) }],
    },
    "/actions/jobs/70/logs": healthyLog,
    "/actions/runs?status=in_progress&per_page=100&page=1": {
      workflow_runs: [{ id: 1 }, { id: 99 }],
    },
    "/actions/runs?status=queued&per_page=100&page=1": { workflow_runs: [{ id: 2 }] },
    "/actions/runs/1/jobs?filter=latest&per_page=100&page=1": {
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
    "/actions/runs/2/jobs?filter=latest&per_page=100&page=1": {
      // A queued box job holds a slot just like a running one, whatever its label's case.
      jobs: [
        job("queued", ["windows-latest"]),
        job("waiting", ["ubuntu-latest"]),
        job("queued", ["Basalt-Box"]),
      ],
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
  assert.deepEqual(await box.active(), { hosted: 3, box: 2 });
  assert.ok(requests.every((request) => request.authorization === "Bearer t"));
  // This Check's own run is counted from its selection, never from the API.
  assert.ok(!requests.some((request) => request.url.startsWith("/actions/runs/99/")));
  const routed = await routeBox(input(), box, () => now);
  assert.deepEqual(routed.jobs, []);
  assert.match(routed.summary, /3 hosted jobs are active/);
  // Over a cap of 10, both slots are held by the two box jobs; a third slot takes one shard.
  const busy = await routeBox(input({ hostedCap: "10" }), box, () => now);
  assert.match(busy.summary, /no box slot is free \(2 box jobs are active, 0 of 2 slots free\)/);
  assert.deepEqual((await routeBox(input({ hostedCap: "10", slots: "3" }), box, () => now)).jobs, [
    "declared-cloud-1",
  ]);

  delete routes["/actions/runs?status=queued&per_page=100&page=1"];
  const failed = await routeBox(input({ hostedCap: "0" }), githubObserver(env, fetcher), () => now);
  assert.deepEqual(failed.jobs, []);
  assert.match(failed.summary, /GitHub returned 404 for \/actions\/runs/);
  routes["/actions/workflows/box-heartbeat.yml/runs?branch=main&status=completed&per_page=1"] = {
    workflow_runs: [],
  };
  await assert.rejects(githubObserver(env, fetcher).heartbeat(), /no completed heartbeat run/);
});

const shardExpression =
  "${{ contains(fromJSON(needs.select.outputs.box_jobs), matrix.shard) && vars.BASALT_CI_BOX_LABEL || 'ubuntu-latest' }}";

test("only declared shard jobs use the router expression; every other job runs hosted", () => {
  for (const id of declaredJobs) {
    assert.ok(heavyJobs.includes(id), id);
    assert.equal(workflow.jobs[id]["runs-on"], shardExpression, id);
    assert.equal(workflow.jobs[id].name, "${{ matrix.shard }}", id);
    assert.ok(workflow.jobs.check.needs.includes(id), id);
  }
  for (const [id, job] of Object.entries<{ "runs-on": string; strategy?: { matrix?: unknown } }>(
    workflow.jobs,
  )) {
    if (declaredJobs.includes(id)) continue;
    assert.equal(
      job["runs-on"],
      id === "client-desktop" ? "${{ matrix.os }}" : "ubuntu-latest",
      id,
    );
    // The router counts each matrix leg as one hosted job of this Check.
    const matrix = job.strategy?.matrix as { include?: unknown[] } | undefined;
    const legs = matrix ? (matrix.include?.length ?? Object.values(matrix).flat().length) : 1;
    if (heavyJobs.includes(id)) assert.equal(legs, matrixLegs[id] ?? 1, id);
  }
  assert.ok(!read(".github/workflows/ci.yml").includes("scripts/ci/job-durations.json"));
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
  assert.equal(select.outputs.hosted_jobs, undefined);
  const step = select.steps.find((candidate: { id?: string }) => candidate.id === "jobs");
  assert.equal(step.env.BOX_SLOTS, "${{ vars.BASALT_CI_BOX_SLOTS }}");
  assert.equal(step.env.BOX_LABEL, "${{ vars.BASALT_CI_BOX_LABEL }}");
  assert.equal(step.env.HOSTED_CAP, "${{ vars.BASALT_CI_HOSTED_CAP }}");
  assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}");
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
    ["fast"],
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
    schedule: [{ cron: "*/5 * * * *" }],
    workflow_dispatch: null,
  });
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
  assert.ok(run.includes("/opt/basalt-health/status.json"));
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
    const result = spawnSync(process.execPath, ["scripts/ci/select-jobs.ts", "--all"], {
      encoding: "utf8",
      env: { ...process.env, ...env, GITHUB_TOKEN: "", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
    });
    assert.equal(result.status, 0, result.stderr);
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
