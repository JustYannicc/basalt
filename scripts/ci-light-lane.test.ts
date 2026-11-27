import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cancelledBy,
  heldCanceller,
  rerunDecision,
  type RerunJob,
  type Run,
} from "./ci/box-rerun.ts";
import { boxSettings } from "./ci/box-router.ts";
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

test("the light lane takes only the first attempt of a push to main, and only a light label", () => {
  let routed = 0;
  for (const combination of combinations)
    for (const light of [label, ""]) {
      const box = boxSettings({ ...input(combination, light), slots: "1" });
      const { event, ref, attempt } = combination;
      const takes =
        light !== "" && attempt === "1" && event === "push" && ref === "refs/heads/main";
      const expected = takes ? light : "";
      assert.equal(lightLabel(input(combination, light)), expected, JSON.stringify(combination));
      // Never wider than box routing: no fork, re-run or other label can take it.
      if (takes) assert.equal(typeof box === "string" ? "" : box.label, light);
      if (takes) routed++;
    }
  // Main's push, which has no head repository of its own; batch pushes and pull requests stay hosted.
  assert.equal(routed, 2);
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
  // It reads no variable and no heartbeat: main is the lane's only user.
  assert.deepEqual(run.env, { GITHUB_TOKEN: "${{ github.token }}" });
  assert.doesNotMatch(rescueSource, /BASALT_CI_LIGHT_LABEL|HEARTBEAT/);
  assert.doesNotMatch(rescueSource, /self-hosted|basalt-box|basalt-release|runs-on: \$\{\{/i);
});

const start = Date.parse("2026-11-26T12:00:00Z");
const ago = (minutes: number) => new Date(start - minutes * 60_000).toISOString();
type FakeJob = { name: string; status: string; labels: string[]; queued: number };
type FakeRun = {
  id: number;
  jobs: FakeJob[];
  attempt?: number;
  head?: string;
  age?: number;
  branch?: string;
  event?: string;
};
const lightJob = (name: string, status: string, queued: number, light = label): FakeJob => ({
  name,
  status,
  labels: [light],
  queued,
});
const mainRuns = (status: string) =>
  `GET /actions/workflows/ci.yml/runs?branch=main&event=push&status=${status}&per_page=100&page=1`;

function fakeGitHub(
  runs: FakeRun[],
  options: { remaining?: number | ((key: string) => number); failing?: RegExp } = {},
) {
  const { remaining = 900, failing } = options;
  const requests: string[] = [];
  const lines: string[] = [];
  const routes = new Map<string, () => unknown>();
  const listed = runs.map((run) => ({
    id: run.id,
    path: ".github/workflows/ci.yml",
    event: run.event ?? "push",
    head_branch: run.branch ?? "main",
    run_attempt: run.attempt ?? 1,
    head_repository: { full_name: run.head ?? repository },
    created_at: ago(run.age ?? 30),
  }));
  routes.set(mainRuns("in_progress"), () => ({
    workflow_runs: listed.slice(0, Math.ceil(listed.length / 2)),
  }));
  routes.set(mainRuns("queued"), () => ({
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
    return new Response(JSON.stringify(route()), {
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
      rescue({ api: "https://api.test", repository, token: "t" }, fetcher, clock, (line) =>
        lines.push(line),
      ),
  };
}

test("a main light job the lane hasn't taken in 3 minutes gets its Check force-cancelled, and the rescue ends red", async () => {
  // No heartbeat is read: with main the lane's only user, the wait itself says the lane is down.
  const github = fakeGitHub([
    {
      id: 101,
      jobs: [
        lightJob("select", "queued", 5),
        { ...lightJob("fast", "in_progress", 6), labels: ["ubuntu-latest"] },
      ],
    },
    { id: 102, jobs: [lightJob("select", "completed", 20), lightJob("check", "completed", 15)] },
    // Any label with the light suffix: the variable may name another, or be deleted by now.
    { id: 103, jobs: [lightJob("check", "queued", 4, "Other-Light")] },
  ]);
  assert.deepEqual(await github.rescue(), { freed: 2, refused: 0 });
  // The cancel is all: box-rerun.yml re-runs the run once GitHub reports its end.
  assert.deepEqual(github.posts(), [
    "POST /actions/runs/101/force-cancel",
    "POST /actions/runs/103/force-cancel",
  ]);
  assert.ok(
    github.lines.some((line) => /cancelled run 101: its select job waited 5 minutes/.test(line)),
  );
  assert.ok(github.lines.some((line) => line.includes("Delete the variable")));
  assert.ok(!github.requests.some((request) => request.includes("box-heartbeat")));
});

test("the rescue acts within its bound: a light job queued 3 minutes is freed, one queued less is not", async () => {
  // Every 5 minutes, at 3 minutes' wait: a held main Check is freed about 8 minutes after it
  // queued, plus GitHub's schedule delay; its re-run then queues for hosted runners like any job.
  for (const [queued, freed] of [
    [3, 1],
    [2.9, 0],
  ] as const) {
    const github = fakeGitHub([{ id: 301, jobs: [lightJob("select", "queued", queued)] }]);
    assert.deepEqual(await github.rescue(), { freed, refused: 0 }, String(queued));
  }
});

test("a deleted variable still frees what the lane holds: the rescue reads none", async () => {
  // The rescue gets no label at all, and the held job's label is the one the variable named.
  const github = fakeGitHub([{ id: 401, jobs: [lightJob("check", "queued", 10)] }]);
  assert.deepEqual(await github.rescue(), { freed: 1, refused: 0 });
  assert.deepEqual(github.posts(), ["POST /actions/runs/401/force-cancel"]);
});

test("young, started, re-run, fork, hosted and non-main jobs are left alone, and a quiet rescue ends green", async () => {
  const github = fakeGitHub([
    { id: 201, jobs: [lightJob("select", "queued", 2)] },
    { id: 202, jobs: [lightJob("select", "in_progress", 10)] },
    { id: 203, attempt: 2, jobs: [lightJob("check", "queued", 10)] },
    { id: 204, head: "fork/repo", jobs: [lightJob("select", "queued", 10)] },
    { id: 205, jobs: [{ ...lightJob("fast", "queued", 10), labels: ["ubuntu-latest"] }] },
    // A Check younger than the wait can't hold a light job yet: its jobs aren't even read.
    { id: 206, age: 2, jobs: [lightJob("select", "queued", 10)] },
    // Only main's push uses the lane; anything else the listing returns is not read.
    { id: 207, branch: "batch/x", jobs: [lightJob("select", "queued", 10)] },
    { id: 208, event: "workflow_dispatch", jobs: [lightJob("select", "queued", 10)] },
  ]);
  assert.deepEqual(await github.rescue(), { freed: 0, refused: 0 });
  assert.deepEqual(github.posts(), []);
  for (const id of [203, 204, 206, 207, 208])
    assert.ok(
      !github.requests.some((request) => request.includes(`/actions/runs/${id}/`)),
      String(id),
    );
  assert.ok(github.lines.some((line) => line.includes("0 of 3 first attempts of main's Check")));
});

test("GitHub answering badly never cancels, and a refused cancel ends the rescue red", async () => {
  for (const failing of [/status=in_progress/, /status=queued/, /\/attempts\/1\/jobs/]) {
    const github = fakeGitHub([{ id: 901, jobs: [lightJob("select", "queued", 10)] }], {
      failing,
    });
    assert.deepEqual(await github.rescue(), { freed: 0, refused: 0 }, String(failing));
    assert.deepEqual(github.posts(), [], String(failing));
    assert.ok(
      github.lines.some((line) => line.includes("could not be read")),
      String(failing),
    );
  }
  const refused = fakeGitHub([{ id: 902, jobs: [lightJob("select", "queued", 10)] }], {
    failing: /force-cancel/,
  });
  assert.deepEqual(await refused.rescue(), { freed: 0, refused: 1 });
  assert.ok(refused.lines.some((line) => line.includes("could not cancel run 902")));
});

test("the rescue bounds its REST calls and leaves the token's last ones to the Checks", async () => {
  const low = fakeGitHub([{ id: 401, jobs: [lightJob("select", "queued", 5)] }], {
    remaining: 150,
  });
  assert.equal((await low.rescue()).freed, 0);
  assert.deepEqual(low.posts(), []);
  assert.ok(low.requests.length <= 1, JSON.stringify(low.requests));
  // The token running low after the listing: the rescue's own reads stop there too.
  const later = fakeGitHub([{ id: 402, jobs: [lightJob("select", "queued", 5)] }], {
    remaining: (key) => (key.includes("/workflows/ci.yml/") ? 150 : 900),
  });
  assert.equal((await later.rescue()).freed, 0);
  assert.ok(!later.requests.some((request) => request.includes("/attempts/")));
  // Each held run is cancelled as found: one that runs out of calls still frees some.
  const many = fakeGitHub(
    Array.from({ length: 120 }, (_, index) => ({
      id: 500 + index,
      jobs: [lightJob("select", "queued", 5)],
    })),
  );
  const { freed } = await many.rescue();
  assert.ok(many.requests.length <= maxCalls, String(many.requests.length));
  assert.ok(freed > 40 && freed < 120, String(freed));
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
const rescuer = "github-actions[bot]";
const decideLight = (
  jobs: RerunJob[],
  superseded = false,
  canceller: string | undefined = rescuer,
) => rerunDecision(cancelledRun, undefined, jobs, "basalt-box", superseded, canceller);

test("box-rerun re-runs a Check whose light job waited for a runner, unless a person cancelled it", () => {
  const stranded = rerunJob(1, "select", [label], "cancelled", queuedMinutes);
  const hosted = rerunJob(2, "fast", ["ubuntu-latest"], "cancelled", 10, "GitHub Actions 1");
  assert.deepEqual(decideLight([stranded, hosted]), { action: "rerun", stuck: [1] });
  // A cancel whose author can't be read is re-run: a rescued run is never left cancelled.
  assert.equal(decideLight([stranded], false, undefined).action, "rerun");
  // GitHub reports a never-run job's runner as "", not null.
  assert.deepEqual(decideLight([{ ...stranded, runnerName: "" }]), { action: "rerun", stuck: [1] });
  // Any label with the light suffix counts, whatever the variable says now.
  assert.equal(decideLight([{ ...stranded, labels: ["Other-Light"] }]).action, "rerun");
  // A light runner that took it only after the wait, in the seconds before the cancel landed; the
  // rescue's listing lags, so from a minute before the wait.
  for (const waited of [queuedMinutes, queuedMinutes - 1])
    assert.equal(
      decideLight([rerunJob(1, "select", [label], "cancelled", waited, "basalt-box-16")]).action,
      "rerun",
      String(waited),
    );
  assert.equal(
    decideLight([rerunJob(1, "select", [label], "cancelled", queuedMinutes - 1.1, "box-16")])
      .action,
    "none",
  );
  // Not long enough, taken in time, not cancelled, or no light job: not the rescue's state.
  for (const job of [
    rerunJob(1, "select", [label], "cancelled", queuedMinutes - 1),
    { ...rerunJob(1, "select", [label], "cancelled", 10, "basalt-box-16"), startedAt: ago(10) },
    rerunJob(1, "select", [label], "success", 10),
    rerunJob(1, "fast", ["ubuntu-latest"], "cancelled", 10),
  ])
    assert.equal(decideLight([job, hosted]).action, "none", JSON.stringify(job));
  // A person's cancel stands, whatever the box shows: the cancel's own record decides.
  assert.deepEqual(decideLight([stranded], false, "a-person"), {
    action: "none",
    why: "@a-person cancelled it, not the light rescue, and that cancel stands",
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

test("box-rerun reads who cancelled a held run from its job's annotations", async () => {
  const note = (message: string) => ({ annotation_level: "failure", message });
  assert.equal(
    cancelledBy([note("The run was canceled forcefully by @github-actions[bot].")]),
    rescuer,
  );
  assert.equal(cancelledBy([note("The run was canceled by @a-person.")]), "a-person");
  for (const notes of [
    [note("Canceling since a higher priority waiting request for 'x' exists")],
    [note("The operation was canceled.")],
    [],
    { message: "not a list" },
  ])
    assert.equal(cancelledBy(notes), undefined, JSON.stringify(notes));
  // Only a run with a light job held is read, from that job's own check run; an error is unknown.
  const held = [rerunJob(41, "select", [label], "cancelled", 5)];
  const reads: string[] = [];
  const answering = (body: unknown) => ({
    call: async () => new Response("{}"),
    json: async <T>(path: string) => {
      reads.push(path);
      if (body instanceof Error) throw body;
      return body as T;
    },
  });
  assert.equal(
    await heldCanceller(answering([note("The run was canceled by @a-person.")]), held),
    "a-person",
  );
  assert.deepEqual(reads, ["/check-runs/41/annotations?per_page=50"]);
  assert.equal(await heldCanceller(answering(new Error("502")), held), undefined);
  reads.length = 0;
  assert.equal(
    await heldCanceller(answering([]), [rerunJob(42, "fast", ["x"], "cancelled", 5)]),
    undefined,
  );
  assert.deepEqual(reads, []);
});

test("box-rerun reads a rescued run's jobs as GitHub lists them", async () => {
  // A job cancelled while queued, as GitHub returns it: no runner, started at its creation.
  const page = {
    total_count: 3,
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
      // One a light runner took as the cancel landed: its start, not its end, measures the wait.
      {
        id: 33,
        name: "check",
        conclusion: "cancelled",
        labels: [label],
        runner_id: 16,
        runner_name: "basalt-box-16",
        created_at: ago(9),
        started_at: ago(2),
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
  assert.deepEqual(rerunDecision(cancelledRun, undefined, jobs, "basalt-box", false, rescuer), {
    action: "rerun",
    stuck: [31, 33],
  });
});

test("box-rerun leaves a light-held Check with a real failure for a person; a lost light runner is none", () => {
  const stranded = rerunJob(1, "check", [label], "cancelled", 5);
  // A light job's failure lost its runner with the lane. The aggregate fails on any cancel.
  assert.deepEqual(
    decideLight([
      stranded,
      rerunJob(2, "long-started", [label], "failure", 0, "basalt-box-16"),
      rerunJob(4, "check (affected)", ["ubuntu-latest"], "failure", 0, "GitHub Actions 2"),
    ]),
    { action: "rerun", stuck: [1] },
  );
  // A box job's failure is real on this path: the rescue frees a held main Check whatever the box
  // says, so only box-watch's box-down verdict excuses a box job.
  const boxFailed = decideLight([
    stranded,
    rerunJob(3, "declared-cloud (1)", ["basalt-box"], "failure", 0, "basalt-box-3"),
  ]);
  assert.equal(boxFailed.action, "report");
  assert.deepEqual(boxFailed.action === "report" && boxFailed.failed, ["declared-cloud (1)"]);
  const real = decideLight([
    stranded,
    rerunJob(5, "fast-units (1)", ["ubuntu-latest"], "failure", 0, "GitHub Actions 3"),
  ]);
  assert.equal(real.action, "report");
  assert.deepEqual(real.action === "report" && real.failed, ["fast-units (1)"]);
});

// box-rerun.yml's other light path: main's push Check that failed on the light runners.
const mainFailed = (attempt = 1, branch = "main"): Run => ({
  id: 8,
  attempt,
  conclusion: "failure",
  event: "push",
  branch,
});
const ran = (id: number, name: string, labels: string[], conclusion: string, runner = "r") =>
  rerunJob(id, name, labels, conclusion, 0, runner);

test("box-rerun re-runs main's Check hosted when only jobs on the light runners failed", () => {
  // select broke on a light runner: its needs were skipped, and the aggregate ran hosted and failed.
  const broke = [
    ran(1, "select", [label], "failure"),
    rerunJob(2, "fast", ["ubuntu-latest"], "skipped", 0),
    ran(3, "check", ["ubuntu-latest"], "failure", "GitHub Actions 9"),
  ];
  assert.deepEqual(rerunDecision(mainFailed(), undefined, broke, "basalt-box"), {
    action: "rerun",
    stuck: [1],
  });
  // Every need passed and the aggregate broke on a light runner: it is re-run hosted too.
  const aggregate = [
    ran(1, "select", [label], "success"),
    ran(2, "fast", ["ubuntu-latest"], "success", "GitHub Actions 2"),
    ran(3, "check", [label], "failure"),
  ];
  assert.deepEqual(rerunDecision(mainFailed(), undefined, aggregate, "basalt-box"), {
    action: "rerun",
    stuck: [3],
  });
});

test("box-rerun leaves main's Check red when a job failed off the light runners, or the Check isn't main's first attempt", () => {
  const real = [
    ran(1, "select", [label], "success"),
    ran(2, "fast", ["ubuntu-latest"], "failure", "GitHub Actions 2"),
    ran(3, "check", [label], "failure"),
  ];
  // Nothing failed on the light runners: nothing is re-run, and the run stays red.
  assert.equal(rerunDecision(mainFailed(), undefined, real, "basalt-box").action, "none");
  // A light failure beside a real one is still a real failure: reported, and not re-run.
  const both = [ran(1, "cpa-pipeline", [label], "failure"), ...real.slice(1)];
  const decision = rerunDecision(mainFailed(), undefined, both, "basalt-box");
  assert.equal(decision.action, "report");
  assert.deepEqual(decision.action === "report" && decision.failed, ["fast (failure)"]);
  const light = [ran(1, "select", [label], "failure")];
  // A failed re-run attempt is never re-run again, and no other branch uses the lane.
  assert.equal(rerunDecision(mainFailed(2), undefined, light, "basalt-box").action, "none");
  assert.equal(
    rerunDecision(mainFailed(1, "batch/x"), undefined, light, "basalt-box").action,
    "none",
  );
  assert.equal(
    rerunDecision({ ...mainFailed(), event: "pull_request" }, undefined, light, "basalt-box")
      .action,
    "none",
  );
  // rerun-failed-jobs re-runs cancelled jobs too, and a job past its timeout reads as cancelled:
  // a hosted job that didn't pass keeps the run red beside a light failure.
  for (const conclusion of ["cancelled", "timed_out"]) {
    const timedOut = [
      ran(1, "cpa-pipeline", [label], "failure"),
      ran(2, "client-connection", ["ubuntu-latest"], conclusion, "GitHub Actions 4"),
    ];
    const kept = rerunDecision(mainFailed(), undefined, timedOut, "basalt-box");
    assert.equal(kept.action, "report", conclusion);
    assert.deepEqual(kept.action === "report" && kept.failed, [
      `client-connection (${conclusion})`,
    ]);
  }
  // Nothing failed on a light runner: only the aggregate failed, hosted.
  const hostedOnly = [ran(3, "check", ["ubuntu-latest"], "failure", "GitHub Actions 9")];
  assert.equal(rerunDecision(mainFailed(), undefined, hostedOnly, "basalt-box").action, "none");
});

test("a second attempt never uses the lane", () => {
  const main = { event: "push", ref: "refs/heads/main", headRepository: repository };
  assert.equal(lightLabel(input({ ...main, attempt: "2" })), "");
  assert.equal(
    evaluate(selectRunsOn, {
      github: githubContext({ ...main, attempt: "2" }),
      vars: { BASALT_CI_LIGHT_LABEL: label },
    }),
    "ubuntu-latest",
  );
  const needs = { select: { result: "success", outputs: { light_label: label } } };
  const github = { run_attempt: "2" };
  assert.equal(evaluate(laterRunsOn, { github, needs }), "ubuntu-latest");
  assert.equal(evaluate(checkRunsOn, { github, needs }), "ubuntu-latest");
});
