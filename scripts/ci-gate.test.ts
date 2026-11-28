import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { heavyJobs } from "./ci/areas.ts";
import { fastJobs, laneBase, startJobErrors, unitLegs } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const gate = fileURLToPath(new URL("./ci/gate.ts", import.meta.url));

const base = "a".repeat(40);
const runGate = (
  needs: Record<string, { result: string }>,
  selected: readonly string[],
  full: boolean,
  fastLaneBase?: string,
  cpaBase = base,
) =>
  spawnSync(process.execPath, [gate], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/1/merge",
      CI_REUSED: "",
      CI_NEEDS: JSON.stringify(needs),
      CI_JOBS: JSON.stringify(selected),
      CI_BOX_JOBS: "[]",
      CI_FULL_SUITE: String(full),
      CI_LANE: full ? "full" : "fast",
      CI_BASE_SHA: base,
      CI_FAST_LANE_BASE: fastLaneBase ?? laneBase(full ? "full" : "fast", base),
      CI_UNIT_LANE_BASES: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: unitLegs }, (_, index) => [
            `leg_${index + 1}`,
            laneBase(full ? "full" : "fast", base),
          ]),
        ),
      ),
      CI_CPA_BASE_SHA: cpaBase,
    },
  });

test("the real workflow dependencies reach the aggregate CLI in fast and full lanes", () => {
  const step = workflow.jobs.check.steps.find(
    (step: { run?: string }) => step.run === "node scripts/ci/gate.ts",
  );
  assert.equal(step.env.CI_NEEDS, "${{ toJSON(needs) }}");
  assert.equal(step.env.CI_BASE_SHA, "${{ needs.select.outputs.base_sha }}");
  assert.equal(step.env.CI_FAST_LANE_BASE, "${{ needs.fast.outputs.lane_base }}");
  assert.equal(step.env.CI_UNIT_LANE_BASES, "${{ toJSON(needs.fast-units.outputs) }}");
  assert.equal(step.env.CI_CPA_BASE_SHA, "${{ needs.cpa-pipeline.outputs.base_sha }}");
  assert.deepEqual(workflow.jobs.fast.outputs, {
    lane_base: "${{ steps.lane.outputs.lane_base }}",
  });
  assert.equal(workflow.jobs.check.if, "always()");
  assert.deepEqual(workflow.jobs["upstream-image"].needs, [
    "select",
    "workerd-assets",
    "long-started",
  ]);
  assert.equal(
    workflow.jobs["workerd-assets"].if,
    "contains(fromJSON(needs.select.outputs.jobs), 'upstream-image')",
  );
  for (const full of [false, true]) {
    const selected = full ? heavyJobs : [];
    const needs = Object.fromEntries(
      workflow.jobs.check.needs.map((job: string) => [
        job,
        {
          result:
            fastJobs.includes(job) ||
            selected.includes(job) ||
            (job === "workerd-assets" && selected.includes("upstream-image"))
              ? "success"
              : "skipped",
        },
      ]),
    );
    const valid = runGate(needs, selected, full);
    assert.equal(valid.status, 0, valid.stderr);
    // fast chose its full-only steps from its own lane and base, so they must be select's.
    for (const other of [
      laneBase(full ? "fast" : "full", base),
      laneBase(full ? "full" : "fast", "b".repeat(40)),
      "",
    ]) {
      const refused = runGate(needs, selected, full, other);
      assert.notEqual(refused.status, 0, other);
      assert.match(refused.stderr, /fast: resolved .*, select /, other);
    }
    // The pipeline guard compared with its own commit, so it must be select's too.
    for (const other of ["b".repeat(40), ""]) {
      const refused = runGate(needs, selected, full, undefined, other);
      assert.notEqual(refused.status, 0, other);
      assert.match(
        refused.stderr,
        new RegExp(`cpa-pipeline: resolved "${other}", select "${base}"`),
        other,
      );
    }
    // A skipped guard reported no commit, and fails as a skipped required job too.
    const skipped = runGate(
      { ...needs, "cpa-pipeline": { result: "skipped" } },
      selected,
      full,
      undefined,
      "",
    );
    assert.notEqual(skipped.status, 0);
    assert.match(skipped.stderr, /cpa-pipeline: expected success, got skipped/);
    assert.match(skipped.stderr, /cpa-pipeline: resolved "", select /);
    for (const result of full
      ? ["failure", "cancelled", "skipped"]
      : ["success", "failure", "cancelled"]) {
      const refused = runGate({ ...needs, "workerd-assets": { result } }, selected, full);
      assert.notEqual(refused.status, 0);
      assert.match(
        refused.stderr,
        new RegExp(`workerd-assets: expected ${full ? "success" : "skipped"}, got ${result}`),
      );
    }
    const missing = { ...needs };
    delete missing["workerd-assets"];
    const refused = runGate(missing, selected, full);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Aggregate gate dependencies differ/);
    assert.match(refused.stderr, /workerd-assets: expected (?:success|skipped), got missing/);
  }
});

test("the retry count runs after every gate verdict but can never change it", () => {
  const job = workflow.jobs.check;
  const gate = job.steps.findIndex(
    (step: { run?: string }) => step.run === "node scripts/ci/gate.ts",
  );
  const download = job.steps.findIndex((step: { uses?: string; with?: { pattern?: string } }) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  const count = job.steps.findIndex((step: { run?: string }) =>
    step.run?.startsWith("node scripts/ci/aggregate-retries.ts "),
  );
  const upload = job.steps.findIndex((step: { with?: { name?: string } }) =>
    step.with?.name?.startsWith("check-e2e-retries-"),
  );
  assert.ok(gate >= 0 && gate < download && download < count && count < upload);
  // Downloads within the run need no more than read-only contents; actions: read only lets a re-run
  // attempt find the flake-rerun.yml run that started it.
  assert.deepEqual(job.permissions, { actions: "read", contents: "read" });
  assert.equal(job.steps[gate].if, undefined);
  assert.equal(job.steps[gate]["continue-on-error"], undefined);
  for (const step of [job.steps[download], job.steps[count], job.steps[upload]]) {
    assert.equal(step.if, "always() && needs.select.outputs.reused != 'true'", step.name);
    assert.equal(step["continue-on-error"], true, step.name);
    assert.ok(step["timeout-minutes"] > 0 && step["timeout-minutes"] <= 5, step.name);
  }
  const output = job.steps[count].run.split(" ").at(-1).replaceAll('"', "");
  assert.equal(job.steps[upload].with.path, output.replace("$RUNNER_TEMP", "${{ runner.temp }}"));
});

test("every job that resolves the comparison must have resolved select's lane and commit", () => {
  const expected = laneBase("affected", base);
  const legs = (value: string) =>
    Object.fromEntries(Array.from({ length: unitLegs }, (_, index) => [`leg_${index + 1}`, value]));
  assert.deepEqual(startJobErrors("affected", base, expected, legs(expected), base), []);
  // A leg that compared with another commit ran another base's focused tests.
  const moved = { ...legs(expected), leg_2: laneBase("affected", "b".repeat(40)) };
  assert.deepEqual(startJobErrors("affected", base, expected, moved, base), [
    `fast-units leg 2: resolved ${JSON.stringify(moved.leg_2)}, select ${JSON.stringify(expected)}`,
  ]);
  // A leg that reported nothing never proves it ran select's lane.
  const { [`leg_${unitLegs}`]: _missing, ...partial } = legs(expected);
  assert.equal(startJobErrors("affected", base, expected, partial, base).length, 1);
  assert.equal(startJobErrors("affected", base, expected, null, base).length, unitLegs);
  assert.equal(startJobErrors("affected", base, "", legs(expected), base).length, 1);
  // cpa-pipeline reports the commit alone, which its guard compared with.
  assert.deepEqual(startJobErrors("affected", base, expected, legs(expected), "b".repeat(40)), [
    `cpa-pipeline: resolved ${JSON.stringify("b".repeat(40))}, select ${JSON.stringify(base)}`,
  ]);
  for (const nothing of ["", undefined, null, expected])
    assert.equal(startJobErrors("affected", base, expected, legs(expected), nothing).length, 1);
  // The workflow's legs are the gate's, and each reports its own output.
  const job = workflow.jobs["fast-units"];
  assert.deepEqual(
    job.strategy.matrix.leg,
    Array.from({ length: unitLegs }, (_, index) => index + 1),
  );
  assert.deepEqual(
    job.outputs,
    Object.fromEntries(
      job.strategy.matrix.leg.map((leg: number) => [
        `leg_${leg}`,
        `\${{ matrix.leg == ${leg} && steps.lane.outputs.lane_base || '' }}`,
      ]),
    ),
  );
});
