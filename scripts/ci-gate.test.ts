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

test("a selected release preflight must pass the Check CLI, and runs only for same-repo PRs", () => {
  const needs = Object.fromEntries(
    workflow.jobs.check.needs.map((job: string) => [
      job,
      {
        result:
          job === "reuse" || fastJobs.includes(job) || job === "release-preflight"
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
        CI_NEEDS: JSON.stringify({ ...needs, "release-preflight": { result } }),
        CI_JOBS: "[]",
        CI_BOAT_JOBS: "[]",
        CI_FULL_SUITE: "false",
        CI_BASELINE_PROBE: "false",
        CI_RESTORE_PREPARATION_PROBE: "false",
        CI_RELEASE_PREFLIGHT: "true",
      },
    });
  assert.equal(invoke("success").status, 0);
  for (const result of ["failure", "cancelled", "skipped"]) {
    const refused = invoke(result);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /release-preflight: expected success/);
  }
  const job = workflow.jobs["release-preflight"];
  assert.match(job.if, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(job.if, /needs\.select\.outputs\.release_preflight == 'true'/);
  assert.equal(
    workflow.jobs.check.steps.find((step: { id?: string }) => step.id === "gate").env
      .CI_RELEASE_PREFLIGHT,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && needs.select.outputs.release_preflight == 'true' }}",
  );
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
  assert.doesNotMatch(probe.if, /POOL_OBSERVATION_STORE_RESTORE_RUN_ID/);
  const aggregate = workflow.jobs.check.steps.find(
    (value: { run?: string }) => value.run === "node scripts/ci/gate.ts",
  );
  assert.equal(aggregate.env.CI_RESTORE_PREPARATION_PROBE, aggregate.env.CI_BASELINE_PROBE);
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

test("the retry count runs after every gate verdict but can never change it", () => {
  const job = workflow.jobs.check;
  const gateIndex = job.steps.findIndex(
    (step: { run?: string }) => step.run === "node scripts/ci/gate.ts",
  );
  const names = [
    "Download each declared shard's retry record",
    "Count declared E2E files that passed only on retry",
  ];
  const [download, count] = names.map((name) =>
    job.steps.findIndex((step: { name?: string }) => step.name === name),
  );
  const upload = job.steps.findIndex(
    (step: { with?: { name?: string } }) => step.with?.name === "check-e2e-retries",
  );
  assert.ok(gateIndex >= 0 && gateIndex < download! && download! < count! && count! < upload);
  // Downloads within the run need no token scope beyond the workflow's read-only default.
  assert.equal(job.permissions, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const index of [download!, count!, upload]) {
    const step = job.steps[index];
    assert.equal(step.if, "always() && needs.reuse.outputs.reused != 'true'", step.name);
    assert.equal(step["continue-on-error"], true, step.name);
  }
  assert.equal(job.steps[gateIndex].if, undefined);
  assert.equal(job.steps[gateIndex]["continue-on-error"], undefined);
  assert.equal(
    job.steps[count!].run,
    'node scripts/ci/aggregate-retries.ts "$RUNNER_TEMP/e2e-retries" "$RUNNER_TEMP/check-e2e-retries/retries.json"',
  );
  assert.equal(job.steps[download!].with.path, "${{ runner.temp }}/e2e-retries");
  assert.equal(job.steps[upload].with.path, "${{ runner.temp }}/check-e2e-retries/retries.json");
  assert.equal(job.steps[upload].with["retention-days"], 90);
});
