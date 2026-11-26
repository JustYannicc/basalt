import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rerunDecision, type RerunJob, type Run } from "./ci/box-rerun.ts";
import { boxSettings, heartbeatMarker, heartbeatPath } from "./ci/box-router.ts";
import {
  checkRunsOn,
  laterRunsOn,
  lightJobs,
  lightLabel,
  queuedMinutes,
  selectLightLabel,
  selectRunsOn,
  usableLightLabel,
  type LightInput,
} from "./ci/light-lane.ts";
import { maxCalls, rescue } from "./ci/light-rescue.ts";
import { attemptJobs } from "./ci/workflow-run.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const workflow = parse(read(".github/workflows/ci.yml"));
const rescueSource = read(".github/workflows/light-rescue.yml");
const rescueWorkflow = parse(rescueSource);

const repository = "owner/repo";
const label = "basalt-light";
const combinations = ["push", "pull_request", "workflow_dispatch", "schedule"].flatMap((event) =>
  ["refs/heads/main", "refs/heads/batch/x", "refs/heads/feature"].flatMap((ref) =>
    ["1", "2"].flatMap((attempt) =>
      [repository, "fork/repo"].map((headRepository) => ({ event, ref, attempt, headRepository })),
    ),
  ),
);
const input = (combination: (typeof combinations)[number], light = label): LightInput => ({
  ...combination,
  repository,
  label: light,
});

test("the light lane takes exactly the Checks box routing may route, and only a light label", () => {
  let routed = 0;
  for (const combination of combinations)
    for (const light of [label, ""]) {
      const box = boxSettings({ ...input(combination, light), slots: "1" });
      const { event, ref, attempt, headRepository } = combination;
      const routes =
        light !== "" &&
        attempt === "1" &&
        ((event === "push" && (ref === "refs/heads/main" || ref.startsWith("refs/heads/batch/"))) ||
          (event === "pull_request" && headRepository === repository));
      const expected = routes ? light : "";
      assert.equal(typeof box === "string" ? "" : box.label, expected, JSON.stringify(combination));
      assert.equal(lightLabel(input(combination, light)), expected, JSON.stringify(combination));
      if (routes) routed++;
    }
  // Main and batch pushes from either head, and this repository's own pull requests.
  assert.equal(routed, 7);
  const first = combinations[0]!;
  assert.equal(lightLabel(input(first)), label);
  // Labels other runners share, labels with no light suffix, and anything that isn't one plain
  // label never route.
  for (const refused of ["self-hosted", "Self-Hosted", "basalt-release", "linux", "x64", "arm64"]) {
    assert.equal(lightLabel(input(first, refused)), "", refused);
    assert.equal(typeof boxSettings({ ...input(first, refused), slots: "1" }), "string", refused);
  }
  for (const other of ["basalt-box", "two words-light", "a,b-light", " " + label, "${{ x }}-light"])
    assert.equal(lightLabel(input(first, other)), "", other);
  assert.equal(lightLabel({ ...input(first), label: undefined }), "");
});

// Evaluates a runs-on expression for the contexts these jobs read. GitHub compares strings without
// case and coerces like loose equality for these values, which the test keeps lowercase.
function evaluate(expression: string, contexts: Record<string, unknown>): unknown {
  const body = /^\$\{\{ (.*) \}\}$/s.exec(expression)?.[1];
  assert.ok(body, expression);
  const js = body
    .replace(/\b(\w+)\.\*\.(\w+)/g, "filter($1, '$2')")
    .replace(
      /\b(github|vars|needs|steps)((?:\.\w+)+)/g,
      (_, root, path: string) => root + path.replaceAll(".", "?."),
    );
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  const functions = {
    startsWith: (a: unknown, b: unknown) =>
      String(a ?? "")
        .toLowerCase()
        .startsWith(String(b).toLowerCase()),
    contains: (a: unknown, b: unknown) =>
      Array.isArray(a) ? a.some((item) => same(item, b)) : String(a ?? "").includes(String(b)),
    endsWith: (a: unknown, b: unknown) =>
      String(a ?? "")
        .toLowerCase()
        .endsWith(String(b).toLowerCase()),
    fromJSON: JSON.parse,
    filter: (object: Record<string, Record<string, unknown>>, key: string) =>
      Object.values(object ?? {}).map((value) => value?.[key]),
  };
  const names = [...Object.keys(contexts), ...Object.keys(functions)];
  return new Function(...names, "return " + js)(
    ...Object.values(contexts),
    ...Object.values(functions),
  );
}

const githubContext = ({ event, ref, attempt, headRepository }: (typeof combinations)[number]) => ({
  event_name: event,
  ref,
  run_attempt: attempt,
  repository,
  event:
    event === "pull_request"
      ? { pull_request: { head: { repo: { full_name: headRepository } } } }
      : {},
});

test("select's runs-on applies lightLabel's rule to the variable; the later jobs read its output", () => {
  // A label other runners share, one with no light suffix, or a list of labels keeps select hosted.
  // An expression can't check the label's characters: select takes a-b/c-light, which the later
  // jobs refuse, and the rescue watches select's rule.
  const values = [
    label,
    "",
    "self-hosted",
    "basalt-release",
    "basalt-box",
    "x-light,b",
    "x y-light",
    "a-b/c-light",
  ];
  for (const value of values)
    if (usableLightLabel(value)) assert.equal(selectLightLabel(value), value, value);
  assert.equal(usableLightLabel("a-b/c-light"), "");
  assert.equal(selectLightLabel("a-b/c-light"), "a-b/c-light");
  for (const combination of combinations)
    for (const light of values)
      assert.equal(
        evaluate(selectRunsOn, {
          github: githubContext(combination),
          vars: { BASALT_CI_LIGHT_LABEL: light },
        }),
        (lightLabel(input(combination, label)) && selectLightLabel(light)) || "ubuntu-latest",
        JSON.stringify({ combination, light }),
      );
  const needs = (light: string, result = "success") => ({
    select: { result: "success", outputs: { light_label: light } },
    fast: { result },
  });
  for (const attempt of ["1", "2"])
    for (const light of [label, ""]) {
      const expected = attempt === "1" && light ? light : "ubuntu-latest";
      const github = { run_attempt: attempt };
      assert.equal(evaluate(laterRunsOn, { github, needs: needs(light) }), expected);
      // A failed need keeps the aggregate on the light runners; a cancelled one sends it hosted.
      for (const result of ["success", "failure", "skipped"])
        assert.equal(evaluate(checkRunsOn, { github, needs: needs(light, result) }), expected);
      assert.equal(
        evaluate(checkRunsOn, { github, needs: needs(light, "cancelled") }),
        "ubuntu-latest",
      );
    }
});

test("only the four light jobs read the light label, and box-watch stays hosted", () => {
  assert.equal(workflow.jobs.select["runs-on"], selectRunsOn);
  assert.equal(workflow.jobs["long-started"]["runs-on"], laterRunsOn);
  assert.equal(workflow.jobs["cpa-pipeline"]["runs-on"], laterRunsOn);
  assert.equal(workflow.jobs.check["runs-on"], checkRunsOn);
  for (const id of lightJobs.filter((id) => id !== "select"))
    assert.ok([workflow.jobs[id].needs].flat().includes("select"), id);
  // box-watch polls for up to 40 minutes and cancels the Check when the box is down.
  assert.equal(workflow.jobs["box-watch"]["runs-on"], "ubuntu-latest");
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (lightJobs.includes(id)) continue;
    assert.doesNotMatch(JSON.stringify(job), /light_label|BASALT_CI_LIGHT_LABEL/, id);
  }
  assert.doesNotMatch(
    JSON.stringify({ ...workflow, jobs: undefined }),
    /light_label|BASALT_CI_LIGHT_LABEL/,
  );
});

type Step = { id?: string; if?: string; run?: string; env?: Record<string, string> };
const selectSteps: Step[] = workflow.jobs.select.steps;
// Whether a select step runs on a Check that reuses a batch Check's result.
const runsOnReuse = (step: Step) =>
  step.if === undefined ||
  evaluate(`\${{ ${step.if} }}`, { steps: { reuse: { outputs: { reused: "true" } } } }) === true;

test("select's light label comes from a token-free step that runs on a reused Check too", () => {
  // main's push Checks mostly reuse a batch Check, and their aggregate is the job that waits.
  const output = /^\$\{\{ steps\.([\w-]+)\.outputs\.light_label \}\}$/.exec(
    workflow.jobs.select.outputs.light_label,
  );
  assert.ok(output, workflow.jobs.select.outputs.light_label);
  const step = selectSteps.find((candidate) => candidate.id === output[1]);
  assert.ok(step, output[1]);
  assert.ok(runsOnReuse(step), String(step.if));
  // The selection step a reused Check skips must not be where the label comes from.
  assert.equal(runsOnReuse(selectSteps.find((candidate) => candidate.id === "jobs")!), false);
  assert.equal(step.run, "node scripts/ci/light-lane.ts");
  assert.deepEqual(step.env, {
    LIGHT_LABEL: "${{ vars.BASALT_CI_LIGHT_LABEL }}",
    HEAD_REPOSITORY: "${{ github.event.pull_request.head.repo.full_name }}",
  });
  // Only this step reads the variable; select-jobs.ts no longer decides the label.
  for (const other of selectSteps.filter((candidate) => candidate !== step))
    assert.doesNotMatch(
      JSON.stringify(other),
      /light_label|BASALT_CI_LIGHT_LABEL/,
      String(other.id),
    );
});

test("the light step writes the label lightLabel returns, and needs no token", () => {
  for (const env of [
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", LIGHT_LABEL: "" },
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/1/merge",
      HEAD_REPOSITORY: "fork/repo",
    },
  ]) {
    const run = {
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY: repository,
      HEAD_REPOSITORY: "",
      LIGHT_LABEL: label,
      ...env,
    };
    const expected = lightLabel({
      event: run.GITHUB_EVENT_NAME,
      ref: run.GITHUB_REF,
      attempt: run.GITHUB_RUN_ATTEMPT,
      repository: run.GITHUB_REPOSITORY,
      headRepository: run.HEAD_REPOSITORY,
      label: run.LIGHT_LABEL,
    });
    const scratch = mkdtempSync(join(tmpdir(), "basalt-light-lane-"));
    const output = join(scratch, "output");
    const { GITHUB_TOKEN: _, ...inherited } = process.env;
    const result = spawnSync(process.execPath, ["scripts/ci/light-lane.ts"], {
      encoding: "utf8",
      env: { ...inherited, ...run, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(output, "utf8");
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(text, `light_label=${expected}\n`, JSON.stringify(env));
  }
  // A main push takes the light runners; a fork's pull request never does.
  assert.equal(
    lightLabel({ event: "push", ref: "refs/heads/main", attempt: "1", repository, label }),
    label,
  );
  assert.equal(
    lightLabel({
      event: "pull_request",
      ref: "refs/pull/1/merge",
      attempt: "1",
      repository,
      headRepository: "fork/repo",
      label,
    }),
    "",
  );
});

test("the rescue runs hosted every 5 minutes, whether or not the lane's variable is set", () => {
  assert.deepEqual(rescueWorkflow.on, {
    schedule: [{ cron: "*/5 * * * *" }],
    workflow_dispatch: null,
  });
  assert.deepEqual(rescueWorkflow.permissions, {});
  assert.deepEqual(rescueWorkflow.concurrency, {
    group: "light-rescue",
    "cancel-in-progress": false,
  });
  type Job = {
    "runs-on": string;
    if?: string;
    permissions: unknown;
    "timeout-minutes": number;
    steps: { run?: string; env?: Record<string, string> }[];
  };
  const jobs = Object.values<Job>(rescueWorkflow.jobs);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job!["runs-on"], "ubuntu-latest");
  // Emptying the variable during an outage must still free the Checks the box holds.
  assert.equal(job!.if, undefined);
  assert.doesNotMatch(rescueSource, /BASALT_CI_LIGHT_LABEL/);
  assert.deepEqual(job!.permissions, { actions: "write", contents: "read" });
  assert.ok(job!["timeout-minutes"] <= 5);
  const run = job!.steps.at(-1)!;
  assert.equal(run.run, "node scripts/ci/light-rescue.ts");
  assert.equal(run.env?.BOX_LABEL, "${{ vars.BASALT_CI_BOX_LABEL }}");
  assert.equal(run.env?.BOX_HEARTBEAT_LABEL, "${{ vars.BASALT_CI_BOX_HEARTBEAT_LABEL }}");
  assert.doesNotMatch(rescueSource, /self-hosted|basalt-box|basalt-release|runs-on: \$\{\{/i);
});

const start = Date.parse("2026-11-26T12:00:00Z");
const ago = (minutes: number) => new Date(start - minutes * 60_000).toISOString();
type Box = { age: number; healthy?: boolean; budget?: number } | "none";
type FakeJob = { name: string; status: string; labels: string[]; queued: number };
type FakeRun = { id: number; jobs: FakeJob[]; attempt?: number; head?: string; age?: number };
const lightJob = (name: string, status: string, queued: number, light = label): FakeJob => ({
  name,
  status,
  labels: [light],
  queued,
});

function fakeGitHub(
  box: Box,
  runs: FakeRun[],
  options: { remaining?: number | ((key: string) => number); failing?: RegExp } = {},
) {
  const { remaining = 900, failing } = options;
  const requests: string[] = [];
  const lines: string[] = [];
  const routes = new Map<string, () => unknown>();
  const heartbeatRuns = "/actions/workflows/box-heartbeat.yml/runs?status=completed&per_page=50";
  if (box === "none") routes.set("GET " + heartbeatRuns, () => ({ workflow_runs: [] }));
  else {
    routes.set("GET " + heartbeatRuns, () => ({
      workflow_runs: [
        {
          id: 7,
          event: "schedule",
          path: heartbeatPath,
          head_repository: { full_name: repository },
          head_branch: "main",
          conclusion: "success",
        },
      ],
    }));
    routes.set("GET /actions/runs/7/jobs?filter=latest&per_page=50&page=1", () => ({
      jobs: [{ id: 70, labels: ["basalt-box"], conclusion: "success", completed_at: ago(box.age) }],
    }));
    routes.set(
      "GET /actions/jobs/70/logs",
      () =>
        heartbeatMarker +
        JSON.stringify({
          at: ago(box.age),
          healthy: box.healthy ?? true,
          ci_budget: box.budget ?? 2,
        }),
    );
  }
  const listed = runs.map((run) => ({
    id: run.id,
    path: ".github/workflows/ci.yml",
    run_attempt: run.attempt ?? 1,
    head_repository: { full_name: run.head ?? repository },
    created_at: ago(run.age ?? 30),
  }));
  routes.set("GET /actions/workflows/ci.yml/runs?status=in_progress&per_page=100&page=1", () => ({
    workflow_runs: listed.slice(0, Math.ceil(listed.length / 2)),
  }));
  routes.set("GET /actions/workflows/ci.yml/runs?status=queued&per_page=100&page=1", () => ({
    workflow_runs: listed.slice(Math.ceil(listed.length / 2)),
  }));
  for (const run of runs) {
    routes.set(`GET /actions/runs/${run.id}/attempts/1/jobs?per_page=50&page=1`, () => ({
      jobs: run.jobs.map((job, index) => ({
        id: run.id * 100 + index,
        name: job.name,
        status: job.status,
        labels: job.labels,
        created_at: ago(job.queued),
      })),
    }));
    routes.set(`POST /actions/runs/${run.id}/force-cancel`, () => ({}));
  }
  const fetcher = async (url: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${url.replace("https://api.test/repos/" + repository, "")}`;
    requests.push(key);
    if (failing?.test(key)) return new Response("bad gateway", { status: 502 });
    const route = routes.get(key);
    if (!route) return new Response("missing", { status: 404 });
    const body = route();
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      headers: {
        "x-ratelimit-remaining": String(typeof remaining === "number" ? remaining : remaining(key)),
      },
    });
  };
  const clock = { now: () => start, wait: async () => {} };
  return {
    requests,
    lines,
    posts: () => requests.filter((request) => request.startsWith("POST")),
    rescue: () =>
      rescue(
        { api: "https://api.test", repository, token: "t", boxLabel: "basalt-box" },
        fetcher,
        clock,
        (line) => lines.push(line),
      ),
  };
}

test("a down box's queued light job gets its Check force-cancelled, and no other Check", async () => {
  for (const box of [{ age: 30 }, { age: 1, healthy: false }, "none"] as const) {
    const github = fakeGitHub(box, [
      {
        id: 101,
        jobs: [
          lightJob("select", "queued", 5),
          { ...lightJob("fast", "in_progress", 6), labels: ["ubuntu-latest"] },
        ],
      },
      {
        id: 102,
        jobs: [lightJob("select", "completed", 20), lightJob("long-started", "completed", 15)],
      },
      // Any label with the light suffix: the variable may name another, or be empty by now.
      { id: 103, jobs: [lightJob("check", "queued", 4, "Other-Light")] },
    ]);
    assert.equal(await github.rescue(), true, JSON.stringify(box));
    // The cancel is all: box-rerun.yml re-runs the run once GitHub reports its end.
    assert.deepEqual(github.posts(), [
      "POST /actions/runs/101/force-cancel",
      "POST /actions/runs/103/force-cancel",
    ]);
    assert.ok(
      github.lines.some((line) => /cancelled run 101: its select job waited 5 minutes/.test(line)),
    );
  }
});

test("an up or holding box keeps its light jobs: 3 calls, and no Check is even listed", async () => {
  for (const box of [{ age: 1 }, { age: 1, budget: 0 }]) {
    const github = fakeGitHub(box, [{ id: 101, jobs: [lightJob("select", "queued", 10)] }]);
    assert.equal(await github.rescue(), true);
    assert.deepEqual(github.posts(), []);
    assert.equal(github.requests.length, 3, JSON.stringify(github.requests));
    assert.ok(github.lines.some((line) => line.includes("the box is up")));
  }
});

test("a down box leaves young, started, re-run, fork and hosted jobs alone", async () => {
  const github = fakeGitHub({ age: 30 }, [
    { id: 201, jobs: [lightJob("select", "queued", 2)] },
    { id: 202, jobs: [lightJob("select", "in_progress", 10)] },
    { id: 203, attempt: 2, jobs: [lightJob("check", "queued", 10)] },
    { id: 204, head: "fork/repo", jobs: [lightJob("select", "queued", 10)] },
    { id: 205, jobs: [{ ...lightJob("fast", "queued", 10), labels: ["ubuntu-latest"] }] },
    // A Check younger than the wait can't hold a light job yet: its jobs aren't even read.
    { id: 206, age: 2, jobs: [lightJob("select", "queued", 10)] },
  ]);
  assert.equal(await github.rescue(), true);
  assert.deepEqual(github.posts(), []);
  for (const id of [203, 204, 206])
    assert.ok(
      !github.requests.some((request) => request.includes(`/actions/runs/${id}/`)),
      String(id),
    );
  assert.ok(github.lines.some((line) => line.includes("0 of 3 first-attempt Checks")));
});

test("GitHub answering badly never counts as a down box, and nothing is cancelled", async () => {
  for (const failing of [
    /box-heartbeat\.yml/,
    /\/actions\/runs\/7\/jobs/,
    /\/actions\/jobs\/70\/logs/,
    /status=in_progress/,
    /\/attempts\/1\/jobs/,
  ]) {
    // A heartbeat this stale would count as down, had it been read.
    const github = fakeGitHub(
      { age: 30 },
      [{ id: 901, jobs: [lightJob("select", "queued", 10)] }],
      {
        failing,
      },
    );
    assert.equal(await github.rescue(), true, String(failing));
    assert.deepEqual(github.posts(), [], String(failing));
    assert.ok(
      github.lines.some((line) => line.includes("could not be read")),
      String(failing),
    );
  }
  // A cancel GitHub refuses leaves the run held, and the rescue fails so someone sees it.
  const refused = fakeGitHub({ age: 30 }, [{ id: 902, jobs: [lightJob("select", "queued", 10)] }], {
    failing: /force-cancel/,
  });
  assert.equal(await refused.rescue(), false);
  assert.ok(refused.lines.some((line) => line.includes("could not cancel run 902")));
});

test("the rescue bounds its REST calls and leaves the token's last ones to the Checks", async () => {
  const low = fakeGitHub({ age: 30 }, [{ id: 401, jobs: [lightJob("select", "queued", 5)] }], {
    remaining: 150,
  });
  assert.equal(await low.rescue(), true);
  assert.deepEqual(low.posts(), []);
  assert.ok(!low.requests.some((request) => request.includes("/actions/workflows/ci.yml/")));
  // The token running low after the heartbeat: the rescue's own reads stop there too.
  const later = fakeGitHub({ age: 30 }, [{ id: 402, jobs: [lightJob("select", "queued", 5)] }], {
    remaining: (key) => (key.includes("/workflows/ci.yml/") ? 150 : 900),
  });
  assert.equal(await later.rescue(), true);
  assert.deepEqual(later.posts(), []);
  assert.ok(!later.requests.some((request) => request.includes("/attempts/")));

  // Each held run is cancelled as found: one that runs out of calls still frees some.
  const many = fakeGitHub(
    { age: 30 },
    Array.from({ length: 120 }, (_, index) => ({
      id: 500 + index,
      jobs: [lightJob("select", "queued", 5)],
    })),
  );
  assert.equal(await many.rescue(), true);
  assert.ok(many.requests.length <= maxCalls, String(many.requests.length));
  const cancels = many.posts().length;
  assert.ok(cancels > 40 && cancels < 120, String(cancels));
  assert.ok(many.lines.some((line) => line.includes("the next rescue")));
});

// box-rerun.yml's side: the state the rescue's cancel leaves, read from the run's own jobs.
const rerunJob = (
  id: number,
  name: string,
  labels: string[],
  conclusion: string,
  waited: number,
  runnerName: string | null = null,
): RerunJob => ({
  id,
  name,
  conclusion,
  labels,
  runnerName,
  createdAt: ago(waited + 1),
  startedAt: runnerName ? ago(1) : ago(waited + 1),
  completedAt: ago(1),
});
const cancelledRun: Run = { id: 7, attempt: 1, conclusion: "cancelled" };
const decideLight = (jobs: RerunJob[], superseded = false, boxUp: boolean | undefined = false) =>
  rerunDecision(cancelledRun, undefined, jobs, "basalt-box", superseded, boxUp);

test("box-rerun re-runs a Check whose light job waited for a runner while the box was not up", () => {
  const stranded = rerunJob(1, "select", [label], "cancelled", queuedMinutes);
  const hosted = rerunJob(2, "fast", ["ubuntu-latest"], "cancelled", 10, "GitHub Actions 1");
  assert.deepEqual(decideLight([stranded, hosted]), { action: "rerun", stuck: [1] });
  // A heartbeat that can't be read counts as not up: a rescued run is never left cancelled.
  assert.equal(decideLight([stranded], false, undefined).action, "rerun");
  // GitHub reports a never-run job's runner as "", not null.
  assert.deepEqual(decideLight([{ ...stranded, runnerName: "" }]), { action: "rerun", stuck: [1] });
  // Any label with the light suffix counts, whatever the variable says now.
  assert.equal(decideLight([{ ...stranded, labels: ["Other-Light"] }]).action, "rerun");
  // A light runner that took it only after the wait, in the seconds before the cancel landed.
  assert.equal(
    decideLight([rerunJob(1, "select", [label], "cancelled", queuedMinutes, "basalt-box-16")])
      .action,
    "rerun",
  );
  // Not long enough, taken in time, not cancelled, or no light job: not the rescue's state.
  for (const job of [
    rerunJob(1, "select", [label], "cancelled", queuedMinutes - 1),
    { ...rerunJob(1, "select", [label], "cancelled", 10, "basalt-box-16"), startedAt: ago(10) },
    rerunJob(1, "select", [label], "success", 10),
    rerunJob(1, "fast", ["ubuntu-latest"], "cancelled", 10),
  ])
    assert.equal(decideLight([job, hosted]).action, "none", JSON.stringify(job));
  // With the box up, the light runners were only busy, and a person's cancel stands.
  assert.deepEqual(decideLight([stranded], false, true), {
    action: "none",
    why: "the box is up, so its light runners were only busy and the cancel was a person's",
  });
  // Only a cancelled first attempt.
  for (const run of [
    { ...cancelledRun, attempt: 2 },
    { ...cancelledRun, conclusion: "failure" },
  ])
    assert.equal(rerunDecision(run, undefined, [stranded], "basalt-box").action, "none");
  // Never past a newer Check of its pull request.
  assert.equal(decideLight([stranded], true).action, "none");
  // A verdict that doesn't hold for this run leaves the light path.
  const other = JSON.stringify({
    run: 8,
    attempt: 1,
    reason: "box-down",
    stuck: [1],
    cutOff: [],
    at: ago(1),
  });
  assert.deepEqual(rerunDecision(cancelledRun, other, [stranded], "basalt-box"), {
    action: "rerun",
    stuck: [1],
  });
  // So does one for this run that names a job the box never held.
  const unheld = JSON.stringify({ ...JSON.parse(other), run: 7, stuck: [99] });
  assert.deepEqual(rerunDecision(cancelledRun, unheld, [stranded], "basalt-box"), {
    action: "rerun",
    stuck: [1],
  });
});

test("box-rerun reads a rescued run's jobs as GitHub lists them", async () => {
  // A job cancelled while queued, as GitHub returns it: no runner, started at its creation.
  const page = {
    total_count: 2,
    jobs: [
      {
        id: 31,
        name: "select",
        conclusion: "cancelled",
        labels: [label],
        runner_id: 0,
        runner_name: "",
        created_at: ago(9),
        started_at: ago(9),
        completed_at: ago(1),
      },
      {
        id: 32,
        name: "fast",
        conclusion: "cancelled",
        labels: ["ubuntu-latest"],
        runner_id: 5,
        runner_name: "GitHub Actions 5",
        created_at: ago(9),
        started_at: ago(8),
        completed_at: ago(1),
      },
    ],
  };
  const github = {
    call: async () => new Response("{}"),
    json: async <T>(path: string) => {
      assert.equal(path, "/actions/runs/7/attempts/1/jobs?per_page=50&page=1");
      return page as T;
    },
  };
  const jobs = await attemptJobs(github, cancelledRun);
  assert.deepEqual(rerunDecision(cancelledRun, undefined, jobs, "basalt-box", false, false), {
    action: "rerun",
    stuck: [31],
  });
});

test("box-rerun leaves a light-held Check with a real failure for a person; a lost runner is none", () => {
  const stranded = rerunJob(1, "check", [label], "cancelled", 5);
  // The box was down: a light or box job's failure lost its runner. The aggregate fails on any
  // cancel.
  assert.deepEqual(
    decideLight([
      stranded,
      rerunJob(2, "long-started", [label], "failure", 0, "basalt-box-16"),
      rerunJob(3, "declared-cloud (1)", ["basalt-box"], "failure", 0, "basalt-box-3"),
      rerunJob(4, "check (affected)", ["ubuntu-latest"], "failure", 0, "GitHub Actions 2"),
    ]),
    { action: "rerun", stuck: [1] },
  );
  const real = decideLight([
    stranded,
    rerunJob(5, "fast-units (1)", ["ubuntu-latest"], "failure", 0, "GitHub Actions 3"),
  ]);
  assert.equal(real.action, "report");
  assert.deepEqual(real.action === "report" && real.failed, ["fast-units (1)"]);
});
