import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fastPlan } from "./ci/fast-plan.ts";
import { fastJobs, startJobs } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const root = fileURLToPath(new URL("../", import.meta.url));
const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const action = parse(
  readFileSync(join(root, ".github/actions/worker-upload-base/action.yml"), "utf8"),
);
type Step = {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, string>;
};
const steps: Step[] = workflow.jobs.fast.steps;
const index = (match: (step: Step) => boolean) => {
  const found = steps.findIndex(match);
  assert.notEqual(found, -1);
  return found;
};
const base = ".generated/worker-uploads-base";

test("every Check's fast job builds the Workers and fails one left under its floor", () => {
  // fast starts with every Check, pull requests included, and the aggregate requires it.
  assert.ok(startJobs.includes("fast") && fastJobs.includes("fast"));
  assert.equal(workflow.jobs.fast.if, undefined);
  const generated = index(
    (step) => step.run === "bun run --cwd .upstream/apps/hosted/cloud framework:build",
  );
  const restore = index(
    (step) => step.uses === "./.github/actions/worker-upload-base" && step.with?.mode === "restore",
  );
  const build = index((step) => step.run === `node scripts/worker-build.ts --base ${base}`);
  const floors = index((step) => step.run === `node scripts/worker-floors.ts --base ${base}`);
  const save = index(
    (step) => step.uses === "./.github/actions/worker-upload-base" && step.with?.mode === "save",
  );
  // The floor check reads the base before save overwrites that path with this commit's sizes.
  assert.ok(generated < restore && restore < build && build < floors && floors < save);
  // Every lane runs them: a pull request's fast lane is the only Check it gets before its batch.
  for (const step of [restore, build, floors]) assert.equal(steps[step]!.if, undefined);
  // main keeps its sizes even when its own floor check fails, so later changes have a base.
  assert.equal(steps[build]!.id, "worker-build");
  assert.equal(steps[save]!.if, "${{ !cancelled() && steps.worker-build.outcome == 'success' }}");
  assert.equal(steps[restore]!.with!.base, "${{ steps.comparison.outputs.base_sha }}");
});

test("the base is main's own records for the exact comparison commit", () => {
  const [restore, copy, save] = action.runs.steps;
  assert.equal(restore.uses, "actions/cache/restore@v4");
  assert.equal(restore.with.key, "basalt-worker-uploads-${{ inputs.base }}");
  assert.equal(restore.with["restore-keys"], undefined);
  const mainPush = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
  assert.equal(copy.if, `inputs.mode == 'save' && ${mainPush}`);
  assert.match(copy.run, /cp -R \.upstream\/apps\/hosted\/cloud\/\.generated\/worker-uploads /);
  assert.equal(save.uses, "actions/cache/save@v4");
  assert.equal(save.if, copy.if);
  assert.equal(save.with.key, "basalt-worker-uploads-${{ github.sha }}");
  assert.equal(save.with.path, restore.with.path);
  assert.equal(restore.with.path, base);
});

test("the local fast runner runs the build and the floor check, and skips the cache", () => {
  const plan = fastPlan(workflow, { root, base: "a".repeat(40), head: "b".repeat(40) });
  const commands = plan.steps.map((step) => step.command);
  assert.ok(commands.includes(`node scripts/worker-build.ts --base ${base}`));
  assert.ok(commands.includes(`node scripts/worker-floors.ts --base ${base}`));
  assert.deepEqual(
    plan.skipped
      .filter((step) => step.reason === "the Worker size cache requires GitHub Actions")
      .map((step) => step.name),
    [
      "Restore the comparison commit's Worker upload sizes",
      "Keep main's Worker upload sizes for later changes to compare with",
    ],
  );
});
