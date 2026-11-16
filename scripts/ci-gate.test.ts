import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { heavyJobs } from "./ci/areas.ts";
import { fastJobs } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const gate = fileURLToPath(new URL("./ci/gate.ts", import.meta.url));

const runGate = (
  needs: Record<string, { result: string }>,
  selected: readonly string[],
  full: boolean,
  baseline: boolean,
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
      CI_BOAT_JOBS: "[]",
      CI_FULL_SUITE: String(full),
      CI_BASELINE_PROBE: String(baseline),
    },
  });

test("the real workflow dependencies reach the aggregate CLI in fast and full lanes", () => {
  const step = workflow.jobs.check.steps.find(
    (step: { run?: string }) => step.run === "node scripts/ci/gate.ts",
  );
  assert.equal(step.env.CI_NEEDS, "${{ toJSON(needs) }}");
  assert.equal(workflow.jobs.check.if, "always()");
  assert.deepEqual(workflow.jobs["upstream-image"].needs, ["select", "workerd-assets"]);
  assert.equal(
    workflow.jobs["workerd-assets"].if,
    "contains(fromJSON(needs.select.outputs.jobs), 'upstream-image')",
  );
  for (const full of [false, true]) {
    const selected = full ? heavyJobs : [];
    for (const baseline of [false, true]) {
      const needs = Object.fromEntries(
        workflow.jobs.check.needs.map((job: string) => [
          job,
          {
            result:
              job === "reuse" ||
              fastJobs.includes(job) ||
              selected.includes(job) ||
              (job === "baseline-probe" && baseline) ||
              (job === "workerd-assets" && selected.includes("upstream-image"))
                ? "success"
                : "skipped",
          },
        ]),
      );
      const valid = runGate(needs, selected, full, baseline);
      assert.equal(valid.status, 0, valid.stderr);
      for (const result of full
        ? ["failure", "cancelled", "skipped"]
        : ["success", "failure", "cancelled"]) {
        const refused = runGate(
          { ...needs, "workerd-assets": { result } },
          selected,
          full,
          baseline,
        );
        assert.notEqual(refused.status, 0);
        assert.match(
          refused.stderr,
          new RegExp(`workerd-assets: expected ${full ? "success" : "skipped"}, got ${result}`),
        );
      }
      const missing = { ...needs };
      delete missing["workerd-assets"];
      const refused = runGate(missing, selected, full, baseline);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /Aggregate gate dependencies differ/);
      assert.match(refused.stderr, /workerd-assets: expected (?:success|skipped), got missing/);
    }
  }
});

test("a selected real restore preparation proof must pass the Check CLI, including fast-only PRs", () => {
  const needs = Object.fromEntries(
    workflow.jobs.check.needs.map((job: string) => [
      job,
      {
        result:
          job === "reuse" || fastJobs.includes(job) || job === "restore-preparation-probe"
            ? "success"
            : "skipped",
      },
    ]),
  );
  const invoke = (result: string) =>
    spawnSync(process.execPath, [gate], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/1/merge",
        CI_REUSED: "",
        CI_NEEDS: JSON.stringify({ ...needs, "restore-preparation-probe": { result } }),
        CI_JOBS: "[]",
        CI_BOAT_JOBS: "[]",
        CI_FULL_SUITE: "false",
        CI_BASELINE_PROBE: "false",
        CI_RESTORE_PREPARATION_PROBE: "true",
      },
    });
  assert.equal(invoke("success").status, 0);
  for (const result of ["failure", "cancelled", "skipped"]) {
    const refused = invoke(result);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /restore-preparation-probe: expected success/);
  }
});

test("only the read-only preparation job consumes its frozen input with the dispatch token permissions", () => {
  const dispatch = parse(
    readFileSync(
      new URL("../.github/workflows/pool-runtime-provision.yml", import.meta.url),
      "utf8",
    ),
  );
  const probe = workflow.jobs["restore-preparation-probe"];
  assert.deepEqual(probe.permissions, dispatch.permissions);
  assert.equal(probe.environment, undefined);
  const step = probe.steps.find(
    (value: { run?: string }) =>
      value.run === "bun scripts/release-barrier/restore-preparation-probe.ts",
  );
  assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(
    step.env.BASALT_RESTORE_PREPARATION_PROBE_INPUT,
    "${{ secrets.BASALT_RESTORE_PREPARATION_PROBE_INPUT }}",
  );
  const readers = Object.entries(workflow.jobs)
    .filter(([, job]) =>
      JSON.stringify(job).includes("secrets.BASALT_RESTORE_PREPARATION_PROBE_INPUT"),
    )
    .map(([name]) => name);
  assert.deepEqual(readers, ["restore-preparation-probe"]);
  assert.doesNotMatch(
    JSON.stringify(probe),
    /CLOUDFLARE_API_TOKEN|EXECUTOR_ENCRYPTION_KEY|POOL_DEPLOYMENT_KEY/,
  );
});
