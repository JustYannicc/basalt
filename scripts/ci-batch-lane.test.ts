import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const lane = workflow.jobs.select.steps.find((step: { id?: string }) => step.id === "jobs").env
  .FULL_SUITE;
const repository = "fixture/repository";
const fullLabels = ["ci:full", "ci:boat", "release-update"];
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
const checkName = (github: object) =>
  evaluate(workflow.jobs.check.name, {
    needs: {
      reuse: { outputs: { reused: "false" } },
      select: { outputs: { full_suite: String(fullSuite(github)) } },
    },
  });

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
