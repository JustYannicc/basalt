import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fastPlan, runFastSteps } from "./ci/fast-plan.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const root = fileURLToPath(new URL("../", import.meta.url));
const context = { root, base: "a".repeat(40), head: "b".repeat(40) };
const document = () => ({
  env: { E2E_BUN_VERSION: "1.4.2" },
  jobs: {
    fast: {
      steps: [
        { uses: "actions/checkout@v4" },
        { uses: "actions/setup-node@v4", with: { "node-version": "24.18.0" } },
        { uses: "oven-sh/setup-bun@v2", with: { "bun-version": "${{ env.E2E_BUN_VERSION }}" } },
        {
          name: "style",
          run: "node scripts/ci/style.ts",
          env: {
            BASE_SHA: "${{ github.event.pull_request.base.sha || github.event.before }}",
            HEAD_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
          },
        },
        { name: "upstream typecheck", "working-directory": ".upstream", run: "bun run typecheck" },
      ],
    },
  },
});

test("the local plan preserves every real CI shell command, in its original order", () => {
  const actual = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  const plan = fastPlan(actual, context);
  assert.deepEqual(
    plan.steps.map((step) => step.command),
    actual.jobs.fast.steps
      .filter((step: { run?: string }) => step.run !== undefined)
      .map((step: { run: string }) => step.run),
  );
  assert.ok(plan.steps.some((step) => step.command === "node scripts/ci/style.ts"));
  assert.ok(
    plan.steps.some(
      (step) => step.name === "Typecheck the patched upstream the way upstream checks itself",
    ),
  );
  assert.equal(plan.nodeVersion, "24.18.0");
  assert.equal(plan.bunVersion, "1.4.2");
});

test("changed-file checks use exact base/head commits and upstream commands keep their directory", () => {
  const plan = fastPlan(document(), context);
  assert.deepEqual(plan.steps[0]!.env, {
    E2E_BUN_VERSION: "1.4.2",
    BASE_SHA: context.base,
    HEAD_SHA: context.head,
  });
  assert.equal(plan.steps[1]!.cwd, join(root, ".upstream"));
  assert.deepEqual(
    plan.steps.map((step) => step.name),
    ["style", "upstream typecheck"],
  );
});

test("a failed command returns its exit code and prevents every following check", () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-fast-stop-"));
  const step = (name: string, command: string) => ({ name, command, cwd: directory, env: {} });
  try {
    const result = runFastSteps(
      [
        step("format", "touch format-ran"),
        step("typecheck", "exit 19"),
        step("later", "touch should-not-run"),
      ],
      process.env,
    );
    assert.deepEqual(result, { status: 19, failed: "typecheck" });
    assert.equal(existsSync(join(directory, "format-ran")), true);
    assert.equal(existsSync(join(directory, "should-not-run")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pipeline failures cannot be hidden by a successful final command", () => {
  const result = runFastSteps(
    [{ name: "pipeline", command: "false | cat", cwd: root, env: {} }],
    process.env,
  );
  assert.deepEqual(result, { status: 1, failed: "pipeline" });
});

test("new workflow semantics fail until the local runner understands them", () => {
  for (const step of [
    { run: "true", if: "false" },
    { run: "true", "continue-on-error": true },
    { run: "true", shell: "pwsh" },
    { uses: "actions/new-check@v1", with: {} },
    { run: "npm run ci:fast" },
    { run: "echo ${{ secrets.UNKNOWN }}" },
    { run: "true", env: { SECRET: "${{ secrets.UNKNOWN }}" } },
    { run: "true", "working-directory": "../outside" },
  ]) {
    const value = document();
    assert.throws(() =>
      fastPlan({ ...value, jobs: { fast: { steps: [...value.jobs.fast.steps, step] } } }, context),
    );
  }
  assert.throws(() => fastPlan({ jobs: {} }, context));
});
