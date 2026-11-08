import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { carryTargets, changedInputs, jobRoutes, selectPaths } from "./ci/affected.ts";
import { selectUnitTests } from "./ci/unit-tests.ts";
import { heavyJobs } from "./ci/areas.ts";
import { bundleJobs, conditionalJobs, fastJobs, gateErrors } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");

test("affected selection is conservative for unknown and shared inputs", () => {
  for (const file of [
    "upstream.json",
    ".github/workflows/ci.yml",
    ".upstream/bun.lock",
    ".upstream/packages/sdk/src/unknown.ts",
    "src/new-feature.ts",
    "scripts/ci.test.ts",
    "scripts/architecture/source.ts",
    "clients/mobile/src/account.ts",
  ]) {
    const selected = selectPaths([file]);
    assert.deepEqual(selected.jobs, heavyJobs, file);
    assert.equal(selected.declaredFiles, null, file);
  }
  assert.deepEqual(selectPaths(["docs/guide.md", "architecture/model/build.c4"]).jobs, []);
  assert.throws(() => selectPaths(["../outside.ts"]));
});

test("an undeclared client change retains every product and platform job", () => {
  const selected = selectPaths(["clients/mobile/src/account.ts"]);
  assert.deepEqual(selected.jobs, heavyJobs);
  assert.equal(selected.declaredFiles, null);
  assert.deepEqual(selected.reasons["client-mobile"], ["clients/mobile/src/account.ts"]);
  const accounts = selectPaths([
    ".upstream/apps/hosted/server/src/implementation/accounts.ts",
  ]).jobs;
  for (const job of [
    "host-managed-accounts",
    "host-managed-accounts-adopted",
    "host-managed-accounts-pool",
    "host-managed-accounts-local",
    "host-managed-accounts-cloud",
    "google-account-recovery",
    "google-account-diagnostics",
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

test("app header and member layout changes retain the publishing layout guard", () => {
  for (const path of [
    ".upstream/packages/ui/src/implementation/dashboard/app-detail.tsx",
    ".upstream/packages/ui/src/implementation/dashboard/publish-app.tsx",
  ])
    assert.deepEqual(selectPaths([path]).jobs, heavyJobs, path);
  for (const path of [
    ".upstream/e2e/tests/member-controls.spec.ts",
    ".upstream/e2e/tests/publishing-off.spec.ts",
  ])
    assert.deepEqual(selectPaths([path]).jobs, ["access-editor-reads"], path);
});

test("access-editor and publishing proofs have a separate deadline from the approval journey", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const job = workflow.jobs["access-editor-reads"];
  const approvals = workflow.jobs["human-in-the-loop"];
  assert.equal(job["timeout-minutes"], 15);
  assert.equal(approvals["timeout-minutes"], 15);
  const commands = job.steps
    .filter((step: { run?: string }) => step.run?.includes("--test-name"))
    .map((step: { run: string }) => step.run);
  assert.deepEqual(commands, [
    'bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts access-editor-reads:publishing-layout)" --workers 1',
    'bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts access-editor-reads:self-host)" --workers 1',
    'bun run e2e:cloud --test-name "$(node ../scripts/ci/e2e-pattern.ts access-editor-reads:cloud)" --workers 1',
  ]);
  for (const command of commands)
    assert.ok(!approvals.steps.some((step: { run?: string }) => step.run === command));
  assert.deepEqual(job.steps.slice(0, 6), approvals.steps.slice(0, 6));
  assert.equal(job.steps.at(-1).with.name, "access-editor-reads-e2e");
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
  assert.deepEqual(vercel, heavyJobs);
});

test("the aggregate blocks missing, failed, cancelled and unexpectedly skipped work", () => {
  const selected = ["production-build"];
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...bundleJobs, ...conditionalJobs].map((job) => [
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
  const expected = [...fastJobs, ...heavyJobs, ...bundleJobs, ...conditionalJobs];
  assert.deepEqual(Object.keys(jobs).sort(), [...expected, "check"].sort());
  assert.deepEqual([...jobs.check.needs].sort(), [...expected].sort());
  for (const job of heavyJobs) {
    assert.deepEqual(
      jobs[job].needs,
      job === "upstream-image" ? ["select", "workerd-assets"] : "select",
      job,
    );
    assert.equal(
      jobs[job].if,
      `contains(fromJSON(needs.select.outputs.hosted_jobs), '${job}')`,
      job,
    );
  }
  assert.equal(jobs.check.if, "always()");
  assert.equal(
    jobs.check.name,
    "${{ needs.select.outputs.full_suite == 'true' && 'check' || 'check (fast-only)' }}",
  );
  assert.deepEqual(workflow.on.push.branches, ["main", "batch/**"]);
  assert.equal(jobs["boat-bundle"].if, "needs.select.outputs.boat_jobs != '[]'");
  assert.equal(
    jobs["boat-bundle"].steps.find((step: { id?: string }) => step.id === "bundle").env
      .BASALT_CI_BOAT_JOBS,
    "${{ needs.select.outputs.boat_jobs_csv }}",
  );
  assert.equal(
    jobs.select.steps.find((step: { id?: string }) => step.id === "jobs").env.FULL_SUITE,
    "${{ github.event_name != 'pull_request' || startsWith(github.head_ref, 'batch/') || contains(github.event.pull_request.labels.*.name, 'ci:full') || contains(github.event.pull_request.labels.*.name, 'release-update') }}",
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
    [...fastJobs, ...heavyJobs, ...bundleJobs, ...conditionalJobs].map((job) => [
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

test("access editor changes select the public independent-read guards", () => {
  for (const path of [
    ".upstream/apps/hosted/web/src/implementation/pages/resource-settings.tsx",
    ".upstream/apps/hosted/web/src/implementation/pages/app-detail.tsx",
    ".upstream/apps/hosted/web/src/implementation/pages/account-actions.tsx",
    ".upstream/e2e/tests/access-editor-reads.spec.ts",
    ".upstream/e2e/support/read-dispatch.ts",
  ])
    assert.ok(selectPaths([path]).jobs.includes("access-editor-reads"), path);
});

test("fast-only and full gates reject missing work and dishonest lane selections", () => {
  const needs = (selected: readonly string[]) =>
    Object.fromEntries(
      [...fastJobs, ...heavyJobs, ...bundleJobs, ...conditionalJobs].map((job) => [
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
  assert.deepEqual(gateErrors(needs([]), [], [], false), []);
  assert.deepEqual(gateErrors(needs(heavyJobs), heavyJobs, [], true), []);
  assert.ok(gateErrors(needs([]), [], [], true).length);
  assert.ok(gateErrors(needs(heavyJobs), heavyJobs, [], false).length);
  for (const job of fastJobs)
    for (const result of ["failure", "cancelled", "skipped"])
      assert.ok(gateErrors({ ...needs([]), [job]: { result } }, [], [], false).length);
  assert.ok(
    gateErrors({ ...needs([]), "production-build": { result: "success" } }, [], [], false).length,
  );
});

test("explicit fast selection never schedules heavy work even without comparison refs", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-ci-lane-"));
  const selector = new URL("./ci/select-jobs.ts", import.meta.url).pathname;
  try {
    for (const lane of ["--fast", "--all"]) {
      execFileSync(process.execPath, [selector, lane], {
        cwd: root,
        env: { ...process.env, BASE_SHA: "invalid", HEAD_SHA: "invalid", BOAT_JOBS: "" },
      });
      const selected = JSON.parse(readFileSync(join(root, ".generated/ci/selection.json"), "utf8"));
      assert.deepEqual(selected.jobs, lane === "--all" ? heavyJobs : []);
      assert.deepEqual(selected.hostedJobs, selected.jobs);
      assert.deepEqual(selected.boatJobs, []);
      assert.equal(selected.full, lane === "--all");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow cancels superseded PRs, preserves each main push and gates build steps", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assert.equal(
    workflow.concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
  );
  assert.equal(
    workflow.concurrency.group,
    "${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'pull_request' && 'pr' || github.run_id }}",
  );
  assert.ok(workflow.on.pull_request.types.includes("labeled"));
  assert.ok(workflow.on.pull_request.types.includes("unlabeled"));
  for (const name of [
    "Verify Cloud startup diagnostics and app listeners",
    "Architecture deployment generation",
    "Typecheck the patched upstream the way upstream checks itself",
  ])
    assert.equal(
      workflow.jobs.fast.steps.find((step: { name?: string }) => step.name === name).if,
      "needs.select.outputs.full_suite == 'true'",
    );
});

test("fast unit selection runs changed tests and nearby source tests, with a conservative fallback", () => {
  const tests = [
    "scripts/ci.test.ts",
    "scripts/ci-prepare.test.ts",
    "src/catalog/feed.test.ts",
    "src/pool/key.test.ts",
  ];
  assert.deepEqual(selectUnitTests(tests, ["src/catalog/feed.ts"]), tests.slice(0, 3));
  assert.deepEqual(selectUnitTests(tests, ["src/pool/key.test.ts"]), [
    tests[0],
    tests[1],
    tests[3],
  ]);
  assert.deepEqual(
    selectUnitTests(tests, ["architecture/model/build.c4", "docs/releases.md"]),
    tests.slice(0, 2),
  );
  for (const input of [
    ".upstream/packages/sdk/index.ts",
    "scripts/ci/gate.ts",
    "package.json",
    "src/new-feature.ts",
  ])
    assert.deepEqual(selectUnitTests(tests, [input]), tests, input);
});

test("batch pushes compare with main even when a force push removes the previous head", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs.select.steps.find(
    (entry: { id?: string }) => entry.id === "comparison",
  );
  const root = mkdtempSync(join(tmpdir(), "basalt-batch-base-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    writeFileSync(join(root, "input"), "base");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", base);
    writeFileSync(join(root, "input"), "batch");
    git("commit", "-qam", "batch");
    const head = git("rev-parse", "HEAD");
    for (const [before, batchPush] of [
      ["0".repeat(40), "false"],
      [base, "false"],
      ["f".repeat(40), "true"],
    ]) {
      const output = join(root, "output");
      writeFileSync(output, "");
      execFileSync("bash", ["-e", "-c", step.run], {
        cwd: root,
        env: {
          ...process.env,
          BASE_SHA: before,
          HEAD_SHA: head,
          BATCH_PUSH: batchPush,
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(readFileSync(output, "utf8"), `base_sha=${base}\n`);
      assert.deepEqual(changedInputs(root, base, head).changed, ["input"]);
    }
    assert.equal(
      workflow.jobs.fast.steps.find(
        (entry: { run?: string }) => entry.run === "node scripts/batch-preflight.ts",
      ).env.BASE_SHA,
      "${{ needs.select.outputs.base_sha }}",
    );
    assert.equal(workflow.jobs["cpa-pipeline"].needs, "select");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Google recovery provisions Chromium before its bounded offline verification", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const job = workflow.jobs["google-account-recovery"];
  const verification = job.steps.findIndex((step: { run?: string }) =>
    step.run?.includes("check-e2e-browser.mjs"),
  );
  assert.ok(
    verification >= 0,
    "The one-minute step must launch the prepared engine without downloading it",
  );
  const preparation = job.steps.findIndex(
    (step: { uses?: string }) => step.uses === "./.github/actions/setup-browser",
  );
  assert.ok(
    preparation >= 0 && preparation < verification,
    "Browser acquisition belongs to preparation",
  );
  assert.equal(job.steps[verification]["timeout-minutes"], 1);
  assert.equal(job.steps[preparation]["timeout-minutes"], 2);
  assert.equal(job["timeout-minutes"], 10);
  assert.doesNotMatch(job.steps[verification].run, /install|curl|wget|bunx/);
});

test("connection control changes select their retained-data browser guard", () => {
  for (const path of [
    ".upstream/apps/hosted/web/src/implementation/pages/app-accounts-client.tsx",
    ".upstream/apps/hosted/web/src/implementation/pages/connection-dialog.tsx",
    ".upstream/e2e/tests/cached-account-controls.spec.ts",
    ".upstream/e2e/tests/cached-provider-policy.spec.ts",
  ])
    assert.ok(selectPaths([path]).jobs.includes("human-in-the-loop"), path);
});

test("first-entry view and route changes select their browser guards", () => {
  for (const path of [
    ".upstream/apps/hosted/web/src/implementation/pages/accounts.tsx",
    ".upstream/apps/hosted/web/src/implementation/pages/approvals.tsx",
    ".upstream/packages/ui/src/implementation/dashboard/accounts.tsx",
    ".upstream/packages/ui/src/implementation/dashboard/review-lazy.tsx",
    ".upstream/apps/hosted/self-host/web/src/implementation/routes/org.$organizationSlug.accounts.index.tsx",
    ".upstream/apps/hosted/cloud/web/src/implementation/routes/org.$organizationSlug.approvals.index.tsx",
    ".upstream/e2e/tests/first-entry-reveal.spec.ts",
    ".upstream/e2e/tests/first-entry-behavior.spec.ts",
    ".upstream/e2e/support/first-entry-reveal-probe.ts",
  ])
    assert.ok(selectPaths([path]).jobs.includes("human-in-the-loop"), path);
});

test("hidden section reads select their browser guards", () => {
  for (const path of [
    ".upstream/e2e/tests/hidden-section-reads.spec.ts",
    ".upstream/e2e/tests/dashboard-client-loading.spec.ts",
    ".upstream/apps/hosted/self-host/web/src/implementation/routes/org.$organizationSlug.tsx",
    ".upstream/apps/hosted/cloud/web/src/implementation/routes/org.$organizationSlug.tsx",
  ])
    assert.ok(selectPaths([path]).jobs.includes("human-in-the-loop"), path);
});

test("a selected image requires successful workerd warming and an unselected image skips it", () => {
  const selected = ["upstream-image"];
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...bundleJobs, ...conditionalJobs].map((job) => [
      job,
      {
        result:
          fastJobs.includes(job) || selected.includes(job) || job === "workerd-assets"
            ? "success"
            : "skipped",
      },
    ]),
  );
  assert.deepEqual(gateErrors(needs, selected), []);
  for (const result of ["failure", "cancelled", "skipped"])
    assert.ok(
      gateErrors({ ...needs, "workerd-assets": { result } }, selected).some((error) =>
        error.startsWith("workerd-assets:"),
      ),
    );
  assert.ok(gateErrors(needs, []).some((error) => error.startsWith("workerd-assets:")));
});
