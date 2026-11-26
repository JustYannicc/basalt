import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boxSettings, heartbeatMarker, heartbeatPath } from "./ci/box-router.ts";
import {
  checkRunsOn,
  laterRunsOn,
  lightJobs,
  lightLabel,
  selectRunsOn,
  type LightInput,
} from "./ci/light-lane.ts";
import { finishCalls, maxCalls, pollLimitMs, pollMs, rescue } from "./ci/light-rescue.ts";

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
  const values = [
    label,
    "",
    "self-hosted",
    "basalt-release",
    "basalt-box",
    "x-light,b",
    "x y-light",
  ];
  for (const combination of combinations)
    for (const light of values)
      assert.equal(
        evaluate(selectRunsOn, {
          github: githubContext(combination),
          vars: { BASALT_CI_LIGHT_LABEL: light },
        }),
        lightLabel(input(combination, light)) || "ubuntu-latest",
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

test("the rescue runs hosted every 5 minutes, only while the variable is set", () => {
  assert.deepEqual(rescueWorkflow.on, {
    schedule: [{ cron: "*/5 * * * *" }],
    workflow_dispatch: null,
  });
  assert.deepEqual(rescueWorkflow.permissions, {});
  // A second rescue waits rather than cancelling the first between a cancel and its re-run.
  assert.deepEqual(rescueWorkflow.concurrency, {
    group: "light-rescue",
    "cancel-in-progress": false,
  });
  type Job = {
    "runs-on": string;
    if: string;
    permissions: unknown;
    "timeout-minutes": number;
    steps: { run?: string; env?: Record<string, string> }[];
  };
  const jobs = Object.values<Job>(rescueWorkflow.jobs);
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.equal(job!["runs-on"], "ubuntu-latest");
  assert.equal(job!.if, "vars.BASALT_CI_LIGHT_LABEL != ''");
  assert.deepEqual(job!.permissions, { actions: "write", contents: "read" });
  assert.ok(job!["timeout-minutes"] <= 5);
  const run = job!.steps.at(-1)!;
  assert.equal(run.run, "node scripts/ci/light-rescue.ts");
  assert.equal(run.env?.LIGHT_LABEL, "${{ vars.BASALT_CI_LIGHT_LABEL }}");
  assert.equal(run.env?.BOX_LABEL, "${{ vars.BASALT_CI_BOX_LABEL }}");
  assert.equal(run.env?.BOX_HEARTBEAT_LABEL, "${{ vars.BASALT_CI_BOX_HEARTBEAT_LABEL }}");
  assert.doesNotMatch(rescueSource, /self-hosted|basalt-box|basalt-release|runs-on: \$\{\{/i);
});

const start = Date.parse("2026-11-26T12:00:00Z");
const ago = (minutes: number) => new Date(start - minutes * 60_000).toISOString();
type Box = { age: number; healthy?: boolean; budget?: number } | "none";
type FakeJob = {
  name: string;
  status: string;
  labels: string[];
  /** Minutes since it was queued. */
  queued: number;
  conclusion?: string;
  /** The runner that took it; queued jobs and ones cancelled before a runner took them have none. */
  runner?: string | null;
  /** Minutes since it ended. */
  ended?: number;
};
type FakeRun = {
  id: number;
  jobs: FakeJob[];
  attempt?: number;
  head?: string;
  event?: string;
  /** Listed as a cancelled run, last updated this many minutes ago, rather than as an active one. */
  cancelled?: number;
  /** The run's status on each read after the cancel; the last one repeats. */
  states?: string[];
  /** How the run ended, and its attempt by then. */
  ended?: { conclusion?: string; attempt?: number };
  /** Newer Checks for its pull request's branch. */
  newer?: number[];
};
const lightJob = (name: string, status: string, queued: number): FakeJob => ({
  name,
  status,
  labels: [label],
  queued,
});
const otherJob = (name: string, labels: string[], conclusion: string): FakeJob => ({
  name,
  status: "completed",
  conclusion,
  labels,
  queued: 20,
  ended: 6,
  runner: "runner-1",
});
/** A light job a cancel stopped `waited` minutes after it was queued, before any runner took it. */
const strandedJob = (name: string, waited: number): FakeJob => ({
  name,
  status: "completed",
  conclusion: "cancelled",
  labels: [label],
  queued: waited + 5,
  ended: 5,
  runner: null,
});

function fakeGitHub(
  box: Box,
  runs: FakeRun[],
  options: { remaining?: number; lastRescue?: string; failing?: RegExp; lightLabel?: string } = {},
) {
  const { remaining = 900, lastRescue = "success", failing } = options;
  let now = start;
  const requests: string[] = [];
  const waits: number[] = [];
  const lines: string[] = [];
  const routes = new Map<string, () => unknown>();
  routes.set("GET /actions/workflows/light-rescue.yml/runs?status=completed&per_page=1", () => ({
    workflow_runs: [{ id: 9, conclusion: lastRescue }],
  }));
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
  const listed = (run: FakeRun) => ({
    id: run.id,
    path: ".github/workflows/ci.yml",
    run_attempt: run.attempt ?? 1,
    event: run.event ?? "push",
    head_branch: "feature",
    head_repository: { full_name: run.head ?? repository },
    updated_at: ago(run.cancelled ?? 0),
  });
  const active = runs.filter((run) => run.cancelled === undefined).map(listed);
  routes.set("GET /actions/workflows/ci.yml/runs?status=in_progress&per_page=100&page=1", () => ({
    workflow_runs: active.slice(0, Math.ceil(active.length / 2)),
  }));
  routes.set("GET /actions/workflows/ci.yml/runs?status=queued&per_page=100&page=1", () => ({
    workflow_runs: active.slice(Math.ceil(active.length / 2)),
  }));
  routes.set("GET /actions/workflows/ci.yml/runs?status=cancelled&per_page=100&page=1", () => ({
    workflow_runs: runs.filter((run) => run.cancelled !== undefined).map(listed),
  }));
  const forceCancelled = new Set<number>();
  for (const run of runs) {
    routes.set(`GET /actions/runs/${run.id}/attempts/1/jobs?per_page=50&page=1`, () => ({
      total_count: run.jobs.length,
      jobs: run.jobs.map((job, index) => {
        // A force-cancel stops every unfinished job; a queued one never had a runner.
        const stopped = forceCancelled.has(run.id) && job.status !== "completed";
        const ran = job.status === "in_progress" || job.status === "completed";
        return {
          id: run.id * 100 + index,
          name: job.name,
          status: stopped ? "completed" : job.status,
          conclusion: stopped ? "cancelled" : (job.conclusion ?? null),
          labels: job.labels,
          runner_name: job.runner !== undefined ? job.runner : ran ? "runner-1" : null,
          created_at: ago(job.queued),
          completed_at: stopped
            ? new Date(now).toISOString()
            : job.ended === undefined
              ? null
              : ago(job.ended),
        };
      }),
    }));
    const states = [...(run.states ?? ["completed"])];
    routes.set(`GET /actions/runs/${run.id}`, () => {
      const status = states.length > 1 ? states.shift()! : states[0]!;
      return {
        id: run.id,
        status,
        conclusion: status === "completed" ? (run.ended?.conclusion ?? "cancelled") : null,
        run_attempt: run.ended?.attempt ?? 1,
      };
    });
    routes.set(`POST /actions/runs/${run.id}/force-cancel`, () => {
      forceCancelled.add(run.id);
      return {};
    });
    routes.set(`POST /actions/runs/${run.id}/rerun-failed-jobs`, () => ({}));
  }
  // Every fake pull request's branch is `feature`.
  routes.set(
    "GET /actions/workflows/ci.yml/runs?event=pull_request&branch=feature&per_page=20",
    () => ({
      workflow_runs: runs
        .flatMap((run) => run.newer ?? [])
        .map((id) => ({ id, status: "in_progress", head_repository: { full_name: repository } })),
    }),
  );
  const fetcher = async (url: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${url.replace("https://api.test/repos/" + repository, "")}`;
    requests.push(key);
    if (failing?.test(key)) return new Response("bad gateway", { status: 502 });
    const route = routes.get(key);
    if (!route) return new Response("missing", { status: 404 });
    const body = route();
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      headers: { "x-ratelimit-remaining": String(remaining) },
    });
  };
  const clock = {
    now: () => now,
    wait: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
  return {
    requests,
    waits,
    lines,
    posts: () => requests.filter((request) => request.startsWith("POST")),
    rescue: () =>
      rescue(
        {
          api: "https://api.test",
          repository,
          token: "t",
          lightLabel: options.lightLabel ?? label,
          boxLabel: "basalt-box",
        },
        fetcher,
        clock,
        (line) => lines.push(line),
      ),
  };
}
const jobsRead = (id: number) => `GET /actions/runs/${id}/attempts/1/jobs?per_page=50&page=1`;

test("a down box's queued light job gets its Check cancelled, then re-run, and no other Check", async () => {
  for (const box of [{ age: 30 }, { age: 1, healthy: false }, "none"] as const) {
    const github = fakeGitHub(box, [
      {
        id: 101,
        jobs: [
          lightJob("select", "queued", 5),
          { ...lightJob("fast", "in_progress", 6), labels: ["ubuntu-latest"] },
        ],
        states: ["in_progress", "completed"],
      },
      {
        id: 102,
        jobs: [lightJob("select", "completed", 20), lightJob("long-started", "completed", 15)],
      },
    ]);
    assert.equal(await github.rescue(), true, JSON.stringify(box));
    assert.deepEqual(github.posts(), [
      "POST /actions/runs/101/force-cancel",
      "POST /actions/runs/101/rerun-failed-jobs",
    ]);
    // The re-run follows the read that saw the run end and the read of its jobs, after one poll
    // interval and no other wait.
    const rerun = github.requests.indexOf("POST /actions/runs/101/rerun-failed-jobs");
    assert.deepEqual(github.requests.slice(rerun - 2, rerun), [
      "GET /actions/runs/101",
      jobsRead(101),
    ]);
    assert.deepEqual(github.waits, [pollMs]);
    assert.ok(
      github.lines.some((line) => /cancelled run 101: its select job waited 5 minutes/.test(line)),
    );
  }
  // A run that reports its end at the first read is re-run without any wait.
  const prompt = fakeGitHub({ age: 30 }, [{ id: 103, jobs: [lightJob("check", "queued", 4)] }]);
  await prompt.rescue();
  assert.deepEqual(prompt.waits, []);
  assert.deepEqual(prompt.requests.slice(-4), [
    "POST /actions/runs/103/force-cancel",
    "GET /actions/runs/103",
    jobsRead(103),
    "POST /actions/runs/103/rerun-failed-jobs",
  ]);
});

test("an up or holding box keeps its light jobs, and no Check is even listed", async () => {
  for (const box of [{ age: 1 }, { age: 1, budget: 0 }]) {
    const github = fakeGitHub(box, [{ id: 101, jobs: [lightJob("select", "queued", 10)] }]);
    assert.equal(await github.rescue(), true);
    assert.deepEqual(github.posts(), []);
    assert.ok(
      github.requests.every(
        (request) =>
          !request.includes("/actions/workflows/ci.yml/") && !request.includes("/attempts/"),
      ),
      JSON.stringify(github.requests),
    );
    assert.ok(github.lines.some((line) => line.includes("the box is up")));
  }
  // The lane is off for any value but the light runners' label: nothing is even read.
  for (const lightLabel of ["", "self-hosted", "basalt-box"]) {
    const off = fakeGitHub({ age: 30 }, [{ id: 101, jobs: [lightJob("select", "queued", 10)] }], {
      lightLabel,
    });
    assert.equal(await off.rescue(), true);
    assert.deepEqual(off.requests, [], lightLabel);
  }
});

test("a down box leaves young, started, re-run, fork and hosted jobs alone", async () => {
  const github = fakeGitHub({ age: 30 }, [
    { id: 201, jobs: [lightJob("select", "queued", 2)] },
    { id: 202, jobs: [lightJob("select", "in_progress", 10)] },
    { id: 203, attempt: 2, jobs: [lightJob("check", "queued", 10)] },
    { id: 204, head: "fork/repo", jobs: [lightJob("select", "queued", 10)] },
    { id: 205, jobs: [{ ...lightJob("fast", "queued", 10), labels: ["ubuntu-latest"] }] },
  ]);
  assert.equal(await github.rescue(), true);
  assert.deepEqual(github.posts(), []);
  for (const id of [203, 204])
    assert.ok(
      !github.requests.some((request) => request.includes(`/actions/runs/${id}/`)),
      String(id),
    );
  assert.ok(github.lines.some((line) => line.includes("0 of 3 first-attempt Checks")));
});

test("a cancelled Check is re-run only when its light job waited for a runner that never came", async () => {
  const runs: FakeRun[] = [
    { id: 701, cancelled: 10, jobs: [strandedJob("select", 4)] },
    { id: 702, cancelled: 10, jobs: [strandedJob("select", 2)] },
    { id: 703, cancelled: 10, jobs: [{ ...strandedJob("select", 4), runner: "light-1" }] },
    { id: 704, cancelled: 180, jobs: [strandedJob("select", 4)] },
    { id: 705, cancelled: 10, attempt: 2, jobs: [strandedJob("select", 4)] },
    { id: 706, cancelled: 10, head: "fork/repo", jobs: [strandedJob("select", 4)] },
    {
      id: 707,
      cancelled: 10,
      event: "pull_request",
      newer: [708],
      jobs: [strandedJob("select", 4)],
    },
    {
      id: 709,
      cancelled: 10,
      jobs: [{ ...strandedJob("fast", 4), labels: ["ubuntu-latest"] }],
    },
  ];
  const github = fakeGitHub({ age: 30 }, runs);
  assert.equal(await github.rescue(), true);
  // Cancelled already, so nothing is cancelled again.
  assert.deepEqual(github.posts(), ["POST /actions/runs/701/rerun-failed-jobs"]);
  for (const id of [704, 705, 706]) assert.ok(!github.requests.includes(jobsRead(id)), String(id));
  assert.ok(github.lines.some((line) => line.includes("and 2 cancelled ones wait")));
  assert.ok(github.lines.some((line) => line.includes("left run 707 cancelled: a newer Check")));

  // While the box is up they are looked for only after a rescue that did not finish, or whose
  // end can't be read, and the active Checks are not listed at all.
  for (const failing of [undefined, /light-rescue\.yml/])
    for (const lastRescue of ["failure", "cancelled"]) {
      const up = fakeGitHub(
        { age: 1 },
        [...runs, { id: 710, jobs: [lightJob("select", "queued", 10)] }],
        {
          lastRescue: failing ? "success" : lastRescue,
          failing,
        },
      );
      assert.equal(await up.rescue(), true);
      assert.deepEqual(up.posts(), ["POST /actions/runs/701/rerun-failed-jobs"]);
      assert.ok(!up.requests.some((request) => /status=(in_progress|queued)/.test(request)));
      assert.ok(up.lines.some((line) => line.includes("the last rescue did not finish")));
    }
  const quiet = fakeGitHub({ age: 1 }, runs);
  assert.equal(await quiet.rescue(), true);
  assert.ok(!quiet.requests.some((request) => request.includes("status=cancelled")));
});

test("a job that failed for real leaves its Check cancelled for a person; a lost runner doesn't", async () => {
  const github = fakeGitHub({ age: 30 }, [
    {
      id: 801,
      jobs: [
        lightJob("select", "queued", 5),
        otherJob("fast-units (1)", ["ubuntu-latest"], "failure"),
      ],
    },
    {
      id: 802,
      jobs: [
        lightJob("check", "queued", 4),
        otherJob("declared-cloud (1)", ["basalt-box"], "failure"),
        otherJob("long-started", [label], "failure"),
      ],
    },
  ]);
  assert.equal(await github.rescue(), true);
  assert.deepEqual(github.posts(), [
    "POST /actions/runs/801/force-cancel",
    "POST /actions/runs/802/force-cancel",
    "POST /actions/runs/802/rerun-failed-jobs",
  ]);
  assert.ok(
    github.lines.some((line) =>
      line.includes(
        "left run 801 cancelled for a person to classify: fast-units (1) failed for real",
      ),
    ),
  );
  // With the box up, a box job's failure is no lost runner.
  const up = fakeGitHub(
    { age: 1 },
    [
      {
        id: 803,
        cancelled: 10,
        jobs: [strandedJob("check", 4), otherJob("declared-cloud (1)", ["basalt-box"], "failure")],
      },
    ],
    { lastRescue: "failure" },
  );
  assert.equal(await up.rescue(), true);
  assert.deepEqual(up.posts(), []);
});

test("a cancelled run is re-run only once it ends within a minute, and never past a newer Check", async () => {
  const stuck = fakeGitHub({ age: 30 }, [
    { id: 301, jobs: [lightJob("cpa-pipeline", "queued", 4)], states: ["in_progress"] },
  ]);
  assert.equal(await stuck.rescue(), false);
  assert.deepEqual(stuck.posts(), ["POST /actions/runs/301/force-cancel"]);
  assert.equal(stuck.waits.length, pollLimitMs / pollMs);
  assert.ok(stuck.waits.every((ms) => ms === pollMs));
  assert.ok(stuck.lines.some((line) => line.includes("run 301 did not end within 60 s")));

  const superseded = fakeGitHub({ age: 30 }, [
    { id: 302, event: "pull_request", jobs: [lightJob("select", "queued", 4)], newer: [303] },
  ]);
  assert.equal(await superseded.rescue(), true);
  assert.deepEqual(superseded.posts(), ["POST /actions/runs/302/force-cancel"]);
  assert.ok(
    superseded.lines.some((line) => line.includes("a newer Check runs for its pull request")),
  );

  // A run something else re-ran, or that passed before the cancel landed, is left as it is.
  const settled = fakeGitHub({ age: 30 }, [
    { id: 311, jobs: [lightJob("select", "queued", 4)], ended: { attempt: 2 } },
    { id: 312, jobs: [lightJob("check", "queued", 4)], ended: { conclusion: "success" } },
  ]);
  assert.equal(await settled.rescue(), true);
  assert.deepEqual(settled.posts(), [
    "POST /actions/runs/311/force-cancel",
    "POST /actions/runs/312/force-cancel",
  ]);
  assert.ok(settled.lines.some((line) => line.includes("left run 311: something else re-ran it")));
  assert.ok(settled.lines.some((line) => line.includes("left run 312: it passed before")));
});

test("GitHub answering badly never counts as a down box, and nothing is cancelled", async () => {
  const held = (): FakeRun[] => [
    { id: 901, jobs: [lightJob("select", "queued", 10)] },
    { id: 902, cancelled: 10, jobs: [strandedJob("select", 4)] },
  ];
  for (const failing of [
    /box-heartbeat\.yml/,
    /\/actions\/runs\/7\/jobs/,
    /\/actions\/jobs\/70\/logs/,
    /status=in_progress/,
    /status=cancelled/,
    /\/attempts\/1\/jobs/,
  ])
    for (const lastRescue of ["success", "failure"]) {
      // A heartbeat this stale would count as down, had it been read.
      const github = fakeGitHub({ age: 30 }, held(), { failing, lastRescue });
      // An unread state fails the rescue only after one that did not finish, so the run that one
      // may have left cancelled is looked for again.
      assert.equal(await github.rescue(), lastRescue === "success", `${failing} ${lastRescue}`);
      assert.deepEqual(github.posts(), [], `${failing} ${lastRescue}`);
      assert.ok(
        github.lines.some((line) => line.includes("could not be read")),
        `${failing} ${lastRescue}`,
      );
    }
});

test("the rescue bounds its REST calls and never strands a run it cancelled", async () => {
  // The token's last calls belong to the Checks: nothing is listed or cancelled.
  const low = fakeGitHub({ age: 30 }, [{ id: 401, jobs: [lightJob("select", "queued", 5)] }], {
    remaining: 150,
  });
  assert.equal(await low.rescue(), true);
  assert.deepEqual(low.posts(), []);
  assert.ok(!low.requests.some((request) => request.includes("/actions/workflows/ci.yml/")));

  const many = fakeGitHub(
    { age: 30 },
    Array.from({ length: 30 }, (_, index) => ({
      id: 500 + index,
      jobs: [lightJob("select", "queued", 5)],
    })),
  );
  assert.equal(await many.rescue(), true);
  assert.ok(many.requests.length <= maxCalls, String(many.requests.length));
  const cancelled = many.posts().filter((post) => post.endsWith("/force-cancel"));
  const rerun = many.posts().filter((post) => post.endsWith("/rerun-failed-jobs"));
  assert.ok(cancelled.length > 0 && cancelled.length < 30);
  // Each one cancelled had its finishing calls left over when it was cancelled.
  assert.ok(many.requests.indexOf(cancelled.at(-1)!) + finishCalls <= maxCalls);
  assert.deepEqual(
    rerun.map((post) => post.split("/")[3]),
    cancelled.map((post) => post.split("/")[3]),
  );
  assert.ok(many.lines.some((line) => line.includes("for the next rescue")));
});
