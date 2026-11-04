import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { carryTargets, changedInputs, jobRoutes, selectPaths } from "./ci/affected.ts";
import { heavyJobs } from "./ci/areas.ts";
import { bundleJobs, fastJobs, gateErrors } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");

test("affected selection is conservative for unknown and shared inputs", () => {
  for (const file of [
    "upstream.json",
    ".github/workflows/ci.yml",
    ".upstream/bun.lock",
    ".upstream/packages/sdk/src/unknown.ts",
    "src/new-feature.ts",
  ])
    assert.deepEqual(selectPaths([file]).jobs, heavyJobs, file);
  assert.deepEqual(
    selectPaths(["docs/guide.md", "architecture/model/build.c4", "scripts/ci.test.ts"]).jobs,
    [],
  );
  assert.throws(() => selectPaths(["../outside.ts"]));
});

test("a client change selects its real product and platform jobs without cloud operation suites", () => {
  const selected = selectPaths(["clients/mobile/src/account.ts"]);
  assert.deepEqual(selected.jobs, ["client-mobile", "client-desktop", "client-native-product"]);
  assert.deepEqual(selected.reasons["client-mobile"], ["clients/mobile/src/account.ts"]);
  const accounts = selectPaths([
    ".upstream/apps/hosted/server/src/implementation/accounts.ts",
  ]).jobs;
  for (const job of [
    "host-managed-accounts",
    "host-managed-accounts-local",
    "host-managed-accounts-cloud",
    "google-account-recovery",
    "contributed-account-recipes",
    "production-ops-identity",
    "production-build",
  ])
    assert.ok(accounts.includes(job), job);
});

test("carry selection reads old and new targets for edits, record-only changes and retirement", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-ci-inputs-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const patch = (target: string) =>
    `diff --git a/${target} b/${target}\n--- a/${target}\n+++ b/${target}\n`;
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    mkdirSync(join(root, "patches"));
    writeFileSync(join(root, "patches/0001-test.patch"), patch("apps/docs/page.ts"));
    writeFileSync(join(root, "patches/0001-test.json"), "{}");
    const base = commit("base");
    writeFileSync(join(root, "patches/0001-test.patch"), patch("packages/sdk/new.ts"));
    const head = commit("retarget");
    assert.deepEqual(changedInputs(root, base, head).inputs, [
      ".upstream/apps/docs/page.ts",
      ".upstream/packages/sdk/new.ts",
    ]);
    writeFileSync(join(root, "patches/0001-test.json"), '{"updated":true}');
    const record = commit("record");
    assert.deepEqual(changedInputs(root, head, record).inputs, [".upstream/packages/sdk/new.ts"]);
    rmSync(join(root, "patches/0001-test.patch"));
    rmSync(join(root, "patches/0001-test.json"));
    const retired = commit("retired");
    assert.deepEqual(changedInputs(root, record, retired).inputs, [
      ".upstream/packages/sdk/new.ts",
    ]);
    writeFileSync(join(root, "patches/0002-missing.json"), "{}");
    const missing = commit("missing");
    assert.throws(() => changedInputs(root, retired, missing), /no patch/);
    assert.throws(() => changedInputs(root, "main", missing), /immutable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported carry paths fail rather than silently selecting no jobs", () => {
  for (const patch of [
    'diff --git "a/file name.ts" "b/file name.ts"',
    "diff --git a/../outside b/../outside",
    "invalid patch",
  ])
    assert.throws(() => carryTargets(patch));
  assert.deepEqual(carryTargets("diff --git a/old.ts b/new.ts"), [
    ".upstream/old.ts",
    ".upstream/new.ts",
  ]);
});

test("pool ingress and carried shared workflow views retain the gates that consume them", () => {
  for (const path of ["src/pool/account-acquisition.ts", "src/pool/token.ts"])
    assert.ok(selectPaths([path]).jobs.includes("upstream-contracts"), path);
  const patch = readFileSync(
    new URL("../patches/0118-workflow-diagram-viewport.patch", import.meta.url),
    "utf8",
  );
  const jobs = selectPaths(carryTargets(patch)).jobs;
  assert.ok(jobs.includes("human-in-the-loop"));
  assert.ok(jobs.includes("production-build"));
});

test("AWS catalog, proof inputs and loopback carries select the AWS runtime proof", () => {
  for (const path of [
    "src/catalog/aws/index.ts",
    "src/catalog/aws/source.json",
    "src/catalog/worker.ts",
    "src/catalog/settings.ts",
    "e2e/aws/browser.mjs",
    "scripts/check-aws.ts",
  ])
    assert.ok(selectPaths([path]).jobs.includes("aws-connectors"), path);
  for (const file of ["0152-loopback-oauth.patch", "0188-loopback-framework-activation.patch"]) {
    const patch = readFileSync(new URL("../patches/" + file, import.meta.url), "utf8");
    for (const target of carryTargets(patch))
      assert.ok(selectPaths([target]).jobs.includes("aws-connectors"), target);
  }
  const vercel = selectPaths(["src/catalog/vercel.json"]).jobs;
  assert.ok(vercel.includes("vercel-sign-in"));
  assert.ok(!vercel.includes("aws-connectors"));
  assert.ok(!selectPaths(["clients/mobile/src/account.ts"]).jobs.includes("aws-connectors"));
});

test("the aggregate blocks missing, failed, cancelled and unexpectedly skipped work", () => {
  const selected = ["production-build"];
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...bundleJobs].map((job) => [
      job,
      { result: fastJobs.includes(job) || selected.includes(job) ? "success" : "skipped" },
    ]),
  );
  assert.deepEqual(gateErrors(needs, selected), []);
  for (const job of [...fastJobs, ...selected])
    for (const result of ["failure", "cancelled", "skipped"])
      assert.ok(gateErrors({ ...needs, [job]: { result } }, selected).length, `${job} ${result}`);
  const { fast: _fast, ...missing } = needs;
  assert.ok(gateErrors(missing, selected).length);
  assert.ok(gateErrors(needs, ["unknown"]).length);
  assert.ok(gateErrors(needs, [...selected, ...selected]).length);
});

test("every workflow job has a gate dependency and declared selection policy", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const jobs = workflow.jobs;
  const expected = [...fastJobs, ...heavyJobs, ...bundleJobs];
  assert.deepEqual(Object.keys(jobs).sort(), [...expected, "check"].sort());
  assert.deepEqual([...jobs.check.needs].sort(), [...expected].sort());
  for (const job of heavyJobs) {
    assert.equal(jobs[job].needs, "select", job);
    assert.equal(
      jobs[job].if,
      `contains(fromJSON(needs.select.outputs.hosted_jobs), '${job}')`,
      job,
    );
  }
  assert.equal(jobs.check.if, "always()");
  assert.equal(jobs["boat-bundle"].if, "needs.select.outputs.boat_jobs != '[]'");
  assert.equal(
    jobs["boat-bundle"].steps.find((step: { id?: string }) => step.id === "bundle").env
      .BASALT_CI_BOAT_JOBS,
    "${{ needs.select.outputs.boat_jobs_csv }}",
  );
  assert.equal(
    jobs.select.steps.find((step: { id?: string }) => step.id === "jobs").env.FULL_SUITE,
    "${{ github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'release-update') }}",
  );
});

test("only affected configured Boat jobs substitute for hosted jobs, and every bundle must pass", () => {
  const selected = ["host-managed-accounts", "production-build"];
  const routes = jobRoutes(selected, "host-managed-accounts,production-ops-identity");
  assert.deepEqual(routes, {
    hostedJobs: ["production-build"],
    boatJobs: ["host-managed-accounts"],
  });
  assert.deepEqual(jobRoutes([], "host-managed-accounts").boatJobs, []);
  assert.throws(() => jobRoutes(selected, "unknown"));
  assert.throws(() => jobRoutes(selected, "production-build"));
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...bundleJobs].map((job) => [
      job,
      {
        result:
          fastJobs.includes(job) || routes.hostedJobs.includes(job) || bundleJobs.includes(job)
            ? "success"
            : "skipped",
      },
    ]),
  );
  assert.deepEqual(gateErrors(needs, selected, routes.boatJobs), []);
  for (const result of ["failure", "cancelled", "skipped"])
    assert.ok(
      gateErrors({ ...needs, "boat-bundle": { result } }, selected, routes.boatJobs).length,
    );
  assert.ok(gateErrors(needs, selected, ["production-ops-identity"]).length);
});

test("carry selection accepts unified diffs without Git headers", () => {
  assert.deepEqual(carryTargets("--- a/old.ts\n+++ b/new.ts\n"), [
    ".upstream/old.ts",
    ".upstream/new.ts",
  ]);
  assert.deepEqual(carryTargets("--- /dev/null\n+++ b/new.ts\n"), [".upstream/new.ts"]);
  assert.deepEqual(carryTargets("--- a/old.ts\n+++ /dev/null\n"), [".upstream/old.ts"]);
  assert.throws(() => carryTargets("--- a/../outside.ts\n+++ b/new.ts\n"));
  for (const name of ["0059-native-device-grants", "0128-planetscale-hosted-oauth"])
    assert.ok(
      carryTargets(readFileSync(new URL(`../patches/${name}.patch`, import.meta.url), "utf8"))
        .length > 0,
    );
});
