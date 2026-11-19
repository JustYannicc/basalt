import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { heavyJobs } from "./ci/areas.ts";
import {
  boxSettings,
  boxSlowdown,
  checkUnits,
  declaredJobs,
  fillBox,
  githubObserver,
  heartbeatMarker,
  hostedOnly,
  matrixLegs,
  readJobDurations,
  routableJobs,
  routeBox,
  routedJob,
  slotMinutes,
  type BoxInput,
  type BoxObserver,
} from "./ci/box-router.ts";
import { conditionalJobs, fastJobs, gateErrors } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const workflow = parse(read(".github/workflows/ci.yml"));
const heartbeatSource = read(".github/workflows/box-heartbeat.yml");
const heartbeatWorkflow = parse(heartbeatSource);

const now = Date.parse("2026-11-19T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const statusLine = (at: string, healthy: unknown) =>
  heartbeatMarker +
  JSON.stringify({ at, load1: 3.1, ci_slots: 3, ci_busy: 1, release_busy: 0, healthy });
const healthyLog = [
  '2026-11-19T11:58:58.1000000Z ##[group]Run status="$(head -c 4096 /opt/basalt-health/status.json)"',
  "2026-11-19T11:58:58.1000000Z printf 'box-health:%s\\n' \"$status\"",
  "2026-11-19T11:58:58.2000000Z " + statusLine(minutesAgo(1.5), true),
].join("\n");
const observer = (
  overrides: Partial<{ log: string; completedAt: string; conclusion: string; active: number }> = {},
) => {
  const calls = { heartbeat: 0, hosted: 0 };
  const box: BoxObserver = {
    async heartbeat() {
      calls.heartbeat++;
      return {
        conclusion: overrides.conclusion ?? "success",
        completedAt: overrides.completedAt ?? minutesAgo(1),
        log: overrides.log ?? healthyLog,
      };
    },
    async hostedActive() {
      calls.hosted++;
      return overrides.active ?? 60;
    },
  };
  return { box, calls };
};
const longJobs = [
  "pool-runtime",
  "host-managed-accounts-pool",
  "account-acquisition",
  "catalog-compat",
  "production-ops",
  "contributed-accounts",
  "client-desktop",
  "production-ops-migrations",
];
const input = (overrides: Partial<BoxInput> = {}): BoxInput => ({
  event: "push",
  ref: "refs/heads/batch/b123",
  slots: "3",
  label: "basalt-box",
  selected: longJobs,
  matrices: {},
  fixedJobs: 4,
  ...overrides,
});
const route = (overrides: Partial<BoxInput> = {}, box = observer().box) =>
  routeBox(input(overrides), box, () => now);

test("a healthy fresh heartbeat with hosted over its cap routes longest first within the budget", async () => {
  // 3 slots give 30 hosted minutes: pool-runtime's two 19-minute legs overrun it, the 18-minute
  // pool job fits, the 16-, 15- and 14-minute jobs would overrun, and production-ops fills the rest.
  const routed = await route();
  assert.deepEqual(routed.jobs, ["host-managed-accounts-pool", "production-ops"]);
  assert.match(routed.summary, /^Box routing: 2 jobs \(30 of 30 budgeted hosted minutes\)/);
  assert.match(
    routed.summary,
    /60 hosted jobs are active and this Check adds 14, against a cap of 40/,
  );
  for (const event of ["refs/heads/main", "refs/heads/batch/b122"])
    assert.equal((await route({ ref: event })).jobs.length, 2, event);
  // A larger box takes pool-runtime first, as one job with both legs.
  assert.deepEqual((await route({ slots: "8" })).jobs.slice(0, 2), [
    "pool-runtime",
    "host-managed-accounts-pool",
  ]);
});

test("routing never takes more jobs than hosted is over its cap", async () => {
  // 4 fast-lane jobs, pool-runtime's 2 legs, 5 single jobs, 2 desktop legs and the migrations job
  // make 14 of this Check's own; 32 active plus 14 is 6 over 40.
  const routed = await route({ slots: "100" }, observer({ active: 32 }).box);
  assert.deepEqual(routed.jobs, [
    "pool-runtime",
    "host-managed-accounts-pool",
    "account-acquisition",
    "catalog-compat",
    "production-ops-migrations",
  ]);
  // One over: pool-runtime's two legs would overshoot, so the next single job goes alone.
  assert.deepEqual(
    (await route({ slots: "100", hostedCap: "45" }, observer({ active: 32 }).box)).jobs,
    ["host-managed-accounts-pool"],
  );
});

test("hosted under its cap routes nothing", async () => {
  for (const active of [0, 10, 24]) {
    const routed = await route({}, observer({ active }).box);
    assert.deepEqual(routed.jobs, [], String(active));
    assert.match(routed.summary, /^Box routing: every job runs hosted, because \d+ hosted jobs/);
  }
});

test("a stale, unhealthy, unmarked or unreadable heartbeat routes nothing", async () => {
  const cases: [string, ReturnType<typeof observer>["box"], RegExp][] = [
    ["stale", observer({ completedAt: minutesAgo(16) }).box, /older than 15 minutes/],
    ["future", observer({ completedAt: minutesAgo(-5) }).box, /older than 15 minutes/],
    ["no end", observer({ completedAt: "" }).box, /older than 15 minutes/],
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
        hostedActive: () => Promise.resolve(99),
      },
      /could not be read: GitHub returned 502/,
    ],
    [
      "load error",
      { heartbeat: observer().box.heartbeat, hostedActive: () => Promise.reject(new Error("no")) },
      /could not be read/,
    ],
  ];
  for (const [name, box, why] of cases) {
    const routed = await route({}, box);
    assert.deepEqual(routed.jobs, [], name);
    assert.match(routed.summary, why, name);
  }
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
    assert.deepEqual(calls, { heartbeat: 0, hosted: 0 });
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
    assert.deepEqual(calls, { heartbeat: 0, hosted: 0 });
  }
  for (const label of [undefined, "", "self-hosted", "basalt-release", "Basalt-Release", "a b"])
    assert.match((await route({ label })).summary, /BASALT_CI_BOX_LABEL/, String(label));
  for (const hostedCap of ["-1", "x", "4.5"])
    assert.match((await route({ hostedCap })).summary, /BASALT_CI_HOSTED_CAP/, hostedCap);
  assert.equal(typeof boxSettings({ ...input(), hostedCap: "" }), "object");
});

test("excluded jobs never route and the budget is honoured", async () => {
  const durations = readJobDurations();
  for (const job of [...Object.keys(hostedOnly), ...fastJobs, "fast"]) {
    assert.ok(!routableJobs.includes(job), job);
    assert.equal(routedJob(job), undefined, job);
  }
  const everything = { slots: "999", hostedCap: "0" };
  const all = await route({ ...everything, selected: heavyJobs }, observer({ active: 500 }).box);
  assert.ok(all.jobs.length > 0);
  for (const job of Object.keys(hostedOnly)) assert.ok(!all.jobs.includes(job), job);
  const units = checkUnits(heavyJobs, {});
  const cost = (id: string) => {
    const unit = units.find((candidate) => candidate.id === id)!;
    return unit.legs * unit.minutes;
  };
  for (const slots of [1, 2, 3, 5, 8, 13]) {
    const budget = (slots * slotMinutes) / boxSlowdown;
    const routed = await route(
      { slots: String(slots), selected: heavyJobs },
      observer({ active: 500 }).box,
    );
    const spent = routed.jobs.reduce((sum, id) => sum + cost(id), 0);
    assert.ok(spent <= budget, String(slots));
    // Every skipped routable job either overran the remaining budget or is shorter than all routed.
    const shortest = Math.min(...routed.jobs.map((id) => units.find((u) => u.id === id)!.minutes));
    for (const unit of units.filter((u) => u.routable && !routed.jobs.includes(u.id)))
      assert.ok(unit.minutes <= shortest || spent + unit.legs * unit.minutes > budget, unit.id);
  }
  assert.equal(boxSlowdown, 2);
  assert.equal(durations["pool-runtime"], 19);
  assert.deepEqual(fillBox([{ id: "a", legs: 1, minutes: 31 }], 5, 30).jobs, []);
  assert.deepEqual(fillBox([{ id: "a", legs: 3, minutes: 5 }], 2, 30).jobs, []);
});

test("declared shard rows route by name with their planned minutes; unknown jobs take the median", () => {
  const matrices = {
    "declared-cloud": {
      include: [
        { shard: "declared-cloud-1", runs: "declared:cloud a.spec.ts declared:cloud b.spec.ts" },
        { shard: "declared-cloud-2", runs: "declared:cloud c.spec.ts" },
      ],
    },
  };
  const units = checkUnits(
    ["declared-cloud", "neon-key-reuse", "pool-inventory", "client-desktop"],
    matrices,
    { "pool-inventory": 9, fast: 10, other: 20, more: 30 },
    {
      "declared:cloud a.spec.ts": 300,
      "declared:cloud b.spec.ts": 180,
      "declared:cloud c.spec.ts": 60,
    },
  );
  assert.deepEqual(units, [
    { id: "declared-cloud-1", legs: 1, minutes: 13, routable: true },
    { id: "declared-cloud-2", legs: 1, minutes: 6, routable: true },
    { id: "neon-key-reuse", legs: 1, minutes: 15, routable: true },
    { id: "pool-inventory", legs: 3, minutes: 9, routable: true },
    { id: "client-desktop", legs: 2, minutes: 0, routable: false },
  ]);
  for (const id of ["declared-cloud-1", "declared-self-host-12", "declared-local-1"])
    assert.ok(declaredJobs.includes(routedJob(id)!), id);
  for (const id of ["declared-cloud", "declared-cloud-x", "pool-runtime-contracts", "unknown"])
    assert.equal(routedJob(id), undefined, id);
});

test("the REST observer reads the newest heartbeat log and counts only hosted active jobs", async () => {
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
        job("queued", ["Basalt-Box"]),
        job("in_progress", ["ubuntu-latest"], "Default"),
        job("queued", ["self-hosted", "basalt-release"]),
      ],
    },
    "/actions/runs/2/jobs?filter=latest&per_page=100&page=1": {
      jobs: [job("queued", ["windows-latest"]), job("waiting", ["ubuntu-latest"])],
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
  assert.equal(await box.hostedActive(), 3);
  assert.ok(requests.every((request) => request.authorization === "Bearer t"));
  // This Check's own run is counted from its selection, never from the API.
  assert.ok(!requests.some((request) => request.url.startsWith("/actions/runs/99/")));
  const routed = await routeBox(input({ selected: longJobs }), box, () => now);
  assert.deepEqual(routed.jobs, []);
  assert.match(routed.summary, /3 hosted jobs are active/);

  delete routes["/actions/runs?status=queued&per_page=100&page=1"];
  const failed = await routeBox(input(), githubObserver(env, fetcher), () => now);
  assert.deepEqual(failed.jobs, []);
  assert.match(failed.summary, /GitHub returned 404 for \/actions\/runs/);
  routes["/actions/workflows/box-heartbeat.yml/runs?branch=main&status=completed&per_page=1"] = {
    workflow_runs: [],
  };
  await assert.rejects(githubObserver(env, fetcher).heartbeat(), /no completed heartbeat run/);
});

const routerExpression = (id: string) =>
  `\${{ contains(fromJSON(needs.select.outputs.box_jobs), '${id}') && vars.BASALT_CI_BOX_LABEL || 'ubuntu-latest' }}`;
const shardExpression =
  "${{ contains(fromJSON(needs.select.outputs.box_jobs), matrix.shard) && vars.BASALT_CI_BOX_LABEL || 'ubuntu-latest' }}";

test("every routable and shard job uses exactly the router expression; nothing else can route", () => {
  assert.deepEqual(
    [...routableJobs, ...declaredJobs, ...Object.keys(hostedOnly)].sort(),
    [...heavyJobs].sort(),
  );
  for (const id of routableJobs) {
    const job = workflow.jobs[id];
    assert.equal(job["runs-on"], routerExpression(id), id);
    assert.equal(job.if, `contains(fromJSON(needs.select.outputs.jobs), '${id}')`, id);
    assert.ok(workflow.jobs.check.needs.includes(id), id);
    assert.equal(job["continue-on-error"], undefined, id);
    // Matrix jobs route whole, and the router counts each of their legs against the cap.
    const matrix = job.strategy?.matrix;
    const legs = matrix?.include?.length ?? Object.values(matrix ?? {}).flat().length;
    assert.equal(legs || 1, matrixLegs[id] ?? 1, id);
  }
  for (const id of declaredJobs) {
    assert.equal(workflow.jobs[id]["runs-on"], shardExpression, id);
    assert.equal(workflow.jobs[id].name, "${{ matrix.shard }}", id);
  }
  assert.equal(workflow.jobs["client-desktop"]["runs-on"], "${{ matrix.os }}");
  for (const [id, job] of Object.entries<{ "runs-on": string }>(workflow.jobs))
    if (!heavyJobs.includes(id)) assert.equal(job["runs-on"], "ubuntu-latest", id);
  for (const id of Object.keys(readJobDurations()))
    assert.ok(workflow.jobs[id], "job-durations.json names an unknown job: " + id);
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
  const box = ["pool-runtime", "host-managed-accounts-pool", "declared-cloud-3"];
  assert.deepEqual(gateErrors(needs, heavyJobs, box, true), []);
  for (const id of ["pool-runtime", "declared-cloud"])
    for (const result of ["failure", "cancelled", "skipped"])
      assert.ok(
        gateErrors({ ...needs, [id]: { result } }, heavyJobs, box, true).some((error) =>
          error.startsWith(id + ":"),
        ),
        `${id}: ${result}`,
      );
  for (const invalid of [["client-desktop"], ["fast"], ["pool-runtime", "pool-runtime"], ["x"]])
    assert.ok(
      gateErrors(needs, heavyJobs, invalid, true).includes("Invalid box-job selection"),
      invalid.join(),
    );
  assert.ok(
    gateErrors(needs, ["production-build"], ["pool-runtime"]).includes("Invalid box-job selection"),
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

test("signed migration proofs keep both bounded adoption shards wherever they run", () => {
  const job = workflow.jobs["production-ops-migrations"];
  assert.equal(job["runs-on"], routerExpression("production-ops-migrations"));
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
