import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { boatJobs, configuredBoatJobs } from "./ci/boat.ts";
import { heavyJobs } from "./ci/areas.ts";
import { conditionalJobs, fastJobs, gateErrors } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);

test("routed jobs read their runner label from one variable and keep individual job gates", () => {
  assert.equal(new Set(boatJobs).size, boatJobs.length);
  for (const id of boatJobs) {
    assert.ok(heavyJobs.includes(id), id);
    const job = workflow.jobs[id];
    assert.deepEqual(
      job.strategy?.matrix,
      id === "pool-runtime" ? { shard: ["contracts", "compatibility"] } : undefined,
      id,
    );
    assert.equal(job.if, `contains(fromJSON(needs.select.outputs.jobs), '${id}')`);
    // The runner label comes only from the variable; unset, every job runs hosted.
    assert.equal(
      job["runs-on"],
      [
        "host-managed-accounts-local",
        "host-managed-accounts-cloud",
        "host-managed-accounts-cloud-actions",
      ].includes(id)
        ? "${{ vars.BASALT_CI_RUNNER_HEAVY || 'ubuntu-latest' }}"
        : `\${{ contains(fromJSON(needs.select.outputs.boat_jobs), '${id}') && vars.BASALT_CI_RUNNER_HEAVY || 'ubuntu-latest' }}`,
    );
    assert.ok(workflow.jobs.check.needs.includes(id), id);
    assert.equal(job["continue-on-error"], undefined, id);
  }
  assert.doesNotMatch(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    /boat-large/,
  );
  assert.equal(workflow.jobs["boat-bundle"], undefined);
  assert.equal(workflow.jobs["boat-check"], undefined);
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...conditionalJobs].map((id) => [
      id,
      { result: conditionalJobs.includes(id) ? "skipped" : "success" },
    ]),
  );
  needs["workerd-assets"] = { result: "success" };
  assert.deepEqual(gateErrors(needs, heavyJobs, boatJobs, true), []);
  for (const id of boatJobs)
    for (const result of ["failure", "cancelled", "skipped"])
      assert.ok(
        gateErrors({ ...needs, [id]: { result } }, heavyJobs, boatJobs, true).some((error) =>
          error.startsWith(id + ":"),
        ),
        `${id}: ${result}`,
      );
});

test("same-repository PR proof requests the full lane without changing normal routing", () => {
  const step = workflow.jobs.select.steps.find((step: { id?: string }) => step.id === "jobs");
  assert.equal(
    step.env.BOAT_JOBS,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && contains(github.event.pull_request.labels.*.name, 'ci:boat') && 'proof' || vars.BASALT_CI_BOAT_JOBS }}",
  );
  assert.ok(
    step.env.FULL_SUITE.includes("contains(github.event.pull_request.labels.*.name, 'ci:boat')"),
  );
  assert.deepEqual(configuredBoatJobs(""), []);
  assert.deepEqual(configuredBoatJobs("proof"), boatJobs);
  assert.deepEqual(configuredBoatJobs(" HOST-MANAGED-ACCOUNTS,host-managed-accounts "), [
    "host-managed-accounts",
  ]);
  for (const value of [
    "unknown",
    "production-ops-identity",
    "production-ops-migrations",
    "client-desktop",
    "declared-self-host",
  ])
    assert.throws(() => configuredBoatJobs(value), /Unknown configured Boat job/);
});

test("the real selector routes a full proof while keeping all original jobs selected", () => {
  const result = spawnSync(process.execPath, ["scripts/ci/select-jobs.ts", "--all"], {
    encoding: "utf8",
    env: { ...process.env, BOAT_JOBS: "proof", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  const selected = JSON.parse(result.stdout);
  assert.equal(selected.full, true);
  assert.deepEqual(selected.jobs, heavyJobs);
  assert.deepEqual([...selected.boatJobs].sort(), [...boatJobs].sort());
  assert.deepEqual(
    selected.hostedJobs,
    heavyJobs.filter((id) => !boatJobs.includes(id)),
  );
});

test("pool fixture networking is scoped to Boat and checked before the original contracts", () => {
  const steps = workflow.jobs["pool-runtime"].steps;
  const firewall = steps.findIndex(
    (step: { name?: string }) =>
      step.name === "Allow pool fixture HTTP from Docker bridges on self-hosted runners",
  );
  const probe = steps.findIndex(
    (step: { name?: string }) =>
      step.name === "Verify containers can reach the host fixture listeners",
  );
  const contracts = steps.findIndex(
    (step: { name?: string }) => step.name === "Check the pool runtime and database contracts",
  );
  assert.equal(steps[firewall].if, "runner.environment == 'self-hosted'");
  assert.deepEqual(steps[firewall].run.trim().split("\n"), [
    "sudo iptables -I INPUT 1 -i docker0 -p tcp -j ACCEPT",
    "sudo iptables -I INPUT 1 -i br+ -p tcp -j ACCEPT",
  ]);
  assert.ok(firewall < probe && probe < contracts);
  assert.equal(steps[probe].if, undefined);
  assert.equal(steps[probe].run, "node scripts/ci/check-docker-host.mjs basalt-1409-pool:test");
  assert.match(steps[contracts].run, /pool-test-shard\.ts "\$POOL_TEST_SHARD"/);
  assert.match(steps[contracts].run, /^node --test --test-concurrency=1 "\$\{files\[@\]\}"$/m);
});

test("signed migration proofs stay hosted with both bounded adoption shards", () => {
  const job = workflow.jobs["production-ops-migrations"];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.ok(!boatJobs.includes("production-ops-migrations"));
  assert.equal(job["timeout-minutes"], 20);
  const adoption = job.steps.filter((step: { run?: string }) =>
    step.run?.startsWith("node scripts/production-ops/prove-provider-adoption.ts"),
  );
  assert.equal(adoption.length, 2);
  for (const shard of [1, 2]) {
    const step = job.steps.find(
      (step: { name?: string }) =>
        step.name === `Verify provider account adoption through signed operations, shard ${shard}`,
    );
    assert.equal(step["timeout-minutes"], 5);
    assert.equal(
      step.run,
      `node scripts/production-ops/prove-provider-adoption.ts --shard ${shard}/2`,
    );
  }
  const migrations = job.steps.find(
    (step: { name?: string }) =>
      step.name === "Verify migration ownership through signed apply verification and replay",
  );
  assert.equal(migrations["timeout-minutes"], 5);
  assert.equal(
    migrations.run,
    'BASALT_SCOPE_PROOF_PATTERN="$(node scripts/ci/e2e-pattern.ts production-ops:migrations)" node scripts/production-ops/prove-scope.ts',
  );
});
