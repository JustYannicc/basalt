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

test("the light lane takes exactly the Checks box routing may route, and only a usable label", () => {
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
  // Labels other runners share, and anything that isn't one plain label, never route.
  for (const refused of ["self-hosted", "Self-Hosted", "basalt-release", "linux", "x64", "arm64"]) {
    assert.equal(lightLabel(input(first, refused)), "", refused);
    assert.equal(typeof boxSettings({ ...input(first, refused), slots: "1" }), "string", refused);
  }
  for (const malformed of ["two words", "a,b", " basalt-light", "${{ x }}"])
    assert.equal(lightLabel(input(first, malformed)), "", malformed);
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
      /\b(github|vars|needs)((?:\.\w+)+)/g,
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
  for (const combination of combinations)
    for (const light of [label, ""])
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
  assert.equal(workflow.jobs.select.outputs.light_label, "${{ steps.jobs.outputs.light_label }}");
  const step = workflow.jobs.select.steps.find(
    (candidate: { id?: string }) => candidate.id === "jobs",
  );
  assert.equal(step.env.LIGHT_LABEL, "${{ vars.BASALT_CI_LIGHT_LABEL }}");
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

test("the real selector outputs the light label only for a Check the light lane takes", () => {
  for (const [env, expected] of [
    [{ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }, label],
    [{ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "2" }, ""],
    [{ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", LIGHT_LABEL: "" }, ""],
    [
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/1/merge",
        HEAD_REPOSITORY: "fork/repo",
      },
      "",
    ],
  ] as const) {
    const scratch = mkdtempSync(join(tmpdir(), "basalt-light-lane-"));
    const output = join(scratch, "output");
    const result = spawnSync(process.execPath, ["scripts/ci/select-jobs.ts", "--all"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REPOSITORY: repository,
        HEAD_REPOSITORY: "",
        LIGHT_LABEL: label,
        BOX_SLOTS: "",
        GITHUB_TOKEN: "",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: "",
        ...env,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(output, "utf8").split("\n");
    rmSync(scratch, { recursive: true, force: true });
    assert.ok(lines.includes("light_label=" + expected), JSON.stringify(env));
  }
});

test("the rescue runs hosted every 5 minutes, only while the variable is set", () => {
  assert.deepEqual(rescueWorkflow.on, {
    schedule: [{ cron: "*/5 * * * *" }],
    workflow_dispatch: null,
  });
  assert.deepEqual(rescueWorkflow.permissions, {});
  // A second rescue waits: one cancelled mid-rescue could leave a run cancelled and not re-run.
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
type FakeJob = { name: string; status: string; labels: string[]; queued: number };
type FakeRun = {
  id: number;
  jobs: FakeJob[];
  attempt?: number;
  head?: string;
  event?: string;
  /** The run's status on each read after the cancel; the last one repeats. */
  states?: string[];
  /** Newer Checks for its pull request's branch. */
  newer?: number[];
};
const lightJob = (name: string, status: string, queued: number): FakeJob => ({
  name,
  status,
  labels: [label],
  queued,
});

function fakeGitHub(box: Box, runs: FakeRun[], remaining = 900) {
  let now = start;
  const requests: string[] = [];
  const waits: number[] = [];
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
    event: run.event ?? "push",
    head_branch: "feature",
    head_repository: { full_name: run.head ?? repository },
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
    const states = [...(run.states ?? ["completed"])];
    routes.set(`GET /actions/runs/${run.id}`, () => {
      const status = states.length > 1 ? states.shift()! : states[0]!;
      return {
        id: run.id,
        status,
        conclusion: status === "completed" ? "cancelled" : null,
        run_attempt: 1,
      };
    });
    for (const action of ["force-cancel", "rerun-failed-jobs"])
      routes.set(`POST /actions/runs/${run.id}/${action}`, () => ({}));
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
          lightLabel: label,
          boxLabel: "basalt-box",
        },
        fetcher,
        clock,
        (line) => lines.push(line),
      ),
  };
}

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
    // The re-run follows the read that saw the run end, after one poll interval and no other wait.
    const rerun = github.requests.indexOf("POST /actions/runs/101/rerun-failed-jobs");
    assert.equal(github.requests[rerun - 1], "GET /actions/runs/101");
    assert.deepEqual(github.waits, [pollMs]);
    assert.ok(
      github.lines.some((line) => /cancelled run 101: its select job waited 5 minutes/.test(line)),
    );
  }
  // A run that reports its end at the first read is re-run without any wait.
  const prompt = fakeGitHub({ age: 30 }, [{ id: 103, jobs: [lightJob("check", "queued", 4)] }]);
  await prompt.rescue();
  assert.deepEqual(prompt.waits, []);
  assert.deepEqual(prompt.requests.slice(-3), [
    "POST /actions/runs/103/force-cancel",
    "GET /actions/runs/103",
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
});

test("the rescue bounds its REST calls and never strands a run it cancelled", async () => {
  // The token's last calls belong to the Checks: nothing is listed or cancelled.
  const low = fakeGitHub({ age: 30 }, [{ id: 401, jobs: [lightJob("select", "queued", 5)] }], 150);
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
