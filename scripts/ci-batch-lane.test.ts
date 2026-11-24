import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkNames } from "./ci/retry-history.ts";
import { runInNewContext } from "node:vm";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const selection = workflow.jobs.select.steps.find((step: { id?: string }) => step.id === "jobs");
const lane = selection.env.FULL_SUITE;
const repository = "fixture/repository";
const fullLabels = ["ci:full", "release-update"];
const labelSets = Array.from({ length: 1 << fullLabels.length }, (_, mask) =>
  fullLabels.filter((_, bit) => mask & (1 << bit)),
);

const pullRequest = (action: string, labels: string[], branch: string, fork = false) => ({
  repository,
  event_name: "pull_request",
  head_ref: branch,
  event: {
    action,
    pull_request: {
      head: { repo: { full_name: fork ? "fork/repository" : repository } },
      labels: labels.map((name) => ({ name })),
    },
  },
});
const push = (branch: string) => ({
  repository,
  event_name: "push",
  ref: `refs/heads/${branch}`,
  head_ref: "",
  run_id: "4242",
  event: {},
});

// GitHub compares strings case-insensitively, reads missing properties as null and has no
// backslash escapes; exact-case, populated fixtures keep JavaScript's reading of this subset
// identical. Numbers, null, `<`, `===`, `?:`, backslashes, keyword operators and calls other than
// startsWith and contains fail here instead of being evaluated differently.
const supported =
  /^(?:\s|'[^'\\]*'|(?:startsWith|contains)\(|(?!(?:delete|in|instanceof|new|null|this|typeof|void)\b)[A-Za-z_]\w*(?:\.(?:[A-Za-z_]\w*|\*))*(?!\s*[\w.(])|[!=]=|!(?!=)|&&|\|\||[(,]|\)(?!\s*\())*$/;
const evaluate = (expression: string, context: Record<string, unknown>): unknown => {
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  assert.match(source, supported);
  return runInNewContext(
    source.replaceAll(".labels.*.name", ".labels.map((label) => label.name)"),
    {
      ...context,
      startsWith: (value: string, prefix: string) => value.startsWith(prefix),
      contains: (values: string[], value: string) => values.includes(value),
    },
  );
};
const fullSuite = (github: object) => {
  const full = evaluate(lane, { github });
  // The select step's shell compares the rendered value with the literal `true`.
  assert.equal(typeof full, "boolean");
  return full;
};
// The lane select's step runs: the full suite, else this repository's affected lane, else fast.
const laneOf = (github: object) =>
  fullSuite(github)
    ? "full"
    : evaluate(selection.env.AFFECTED_LANE, { github }) === true
      ? "affected"
      : "fast";
const checkName = (github: object) =>
  evaluate(workflow.jobs.check.name, {
    needs: {
      reuse: { outputs: { reused: "false" } },
      select: { outputs: { full_suite: String(fullSuite(github)), lane: laneOf(github) } },
    },
  });
const concurrencyGroup = (github: object) =>
  evaluate(/\$\{\{((?:(?!\$\{\{).)*)\}\}$/.exec(workflow.concurrency.group)![1]!, { github });

test("a batch push with an open PR selects one full Check, named check", () => {
  // A paths, ignore or negated branch filter would let some batch pushes start no Check at all.
  assert.deepEqual(workflow.on.push, { branches: ["main", "batch/**"] });
  const batchPush = push("batch/proof");
  assert.equal(checkName(batchPush), "check");
  for (const action of workflow.on.pull_request.types)
    for (const labels of labelSets) {
      const pr = pullRequest(action, labels, "batch/proof");
      assert.deepEqual(
        [batchPush, pr].filter(fullSuite).map((run) => run.event_name),
        ["push"],
        `${action} [${labels}]`,
      );
      assert.equal(checkName(pr), "check (fast-only)");
    }
});

test("Checks without a batch push for the same head keep their lanes", () => {
  assert.equal(fullSuite(push("main")), true);
  for (const action of workflow.on.pull_request.types)
    for (const labels of labelSets) {
      const name = `${action} [${labels}]`;
      assert.equal(fullSuite(pullRequest(action, labels, "batch/proof", true)), true, name);
      for (const fork of [false, true])
        assert.equal(
          fullSuite(pullRequest(action, labels, "feature/proof", fork)),
          labels.length > 0,
          name,
        );
    }
});

test("each event selects its lane, concurrency group, selection command and aggregate name", () => {
  const scratch = mkdtempSync(join(tmpdir(), "basalt-ci-lane-"));
  // A stand-in node records the commands the select step runs instead of running them.
  writeFileSync(join(scratch, "node"), '#!/bin/sh\necho "$*" >> "$LOG"\n');
  chmodSync(join(scratch, "node"), 0o755);
  const commands = (github: object) => {
    const log = join(scratch, "log");
    writeFileSync(log, "");
    execFileSync("bash", ["-e", "-c", selection.run], {
      env: {
        ...process.env,
        PATH: scratch + ":" + process.env.PATH,
        LOG: log,
        FULL_SUITE: String(fullSuite(github)),
        AFFECTED_LANE: String(laneOf(github) === "affected"),
      },
    });
    return readFileSync(log, "utf8").trim().split("\n");
  };
  const cases = [
    ["same-repository pull request", pullRequest("synchronize", [], "feature/proof"), "affected"],
    ["labelled ci:full", pullRequest("labeled", ["ci:full"], "feature/proof"), "full"],
    ["fork pull request", pullRequest("synchronize", [], "feature/proof", true), "fast"],
    ["push to main", push("main"), "full"],
    ["push to a batch branch", push("batch/proof"), "full"],
  ] as const;
  try {
    for (const [name, github, expected] of cases) {
      assert.equal(laneOf(github), expected, name);
      assert.deepEqual(
        commands(github),
        [
          "scripts/ci/cancel-superseded.ts",
          "scripts/ci/select-jobs.ts" + { full: " --all", affected: "", fast: " --fast" }[expected],
        ],
        name,
      );
      assert.equal(
        checkName(github),
        { full: "check", affected: "check (affected)", fast: "check (fast-only)" }[expected],
        name,
      );
      // Pushes keep a group per run; a pull request's full runs never share the lane runs' group.
      assert.equal(
        concurrencyGroup(github),
        github.event_name === "push" ? "4242" : expected === "full" ? "pr-full" : "pr",
        name,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(
    workflow.concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
  );
  // A same-repository batch pull request stays fast: its branch push runs the full suite.
  assert.equal(laneOf(pullRequest("synchronize", [], "batch/proof")), "fast");
});

test("every pull request event lands in the concurrency group of its own lane", () => {
  // The group repeats the full-suite condition; a drift would put a full run in the lane's group.
  for (const action of workflow.on.pull_request.types)
    for (const labels of labelSets)
      for (const branch of ["feature/proof", "batch/proof"])
        for (const fork of [false, true]) {
          const github = pullRequest(action, labels, branch, fork);
          assert.equal(
            concurrencyGroup(github),
            fullSuite(github) ? "pr-full" : "pr",
            `${action} [${labels}] ${branch} ${fork}`,
          );
          assert.ok((checkNames as readonly string[]).includes(String(checkName(github))));
        }
  for (const name of checkNames) assert.ok(workflow.jobs.check.name.includes(`'${name}'`), name);
});
