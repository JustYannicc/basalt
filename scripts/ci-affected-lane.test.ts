import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { changedInputs, selectPaths, workflowInputs } from "./ci/affected.ts";
import { heavyJobs } from "./ci/areas.ts";
import { supersededRuns } from "./ci/cancel-superseded.ts";
import { fastJobs } from "./ci/gate.ts";
import { dependents, sourceReferences, trackedFiles } from "./ci/import-graph.ts";
import { commands, jobEntries, parseWorkflow, readWorkflow } from "./ci/job-inputs.ts";
import { ownedUnitSuite, reach } from "./ci/reach.ts";
import { selectUnitTests } from "./ci/unit-tests.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const select = (paths: string[]) => selectPaths(paths, root);
const homeCarry = "containers/pool/patches/0169-home-oauth-completion-receipts.patch";
const { stringify } = createRequire(new URL("./architecture/package.json", import.meta.url))(
  "yaml",
);
const definition = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const edit = (text: string, from: string, to: string) => {
  assert.equal(text.split(from).length, 2, from);
  return text.replace(from, to);
};
const nothing = { declaredFiles: [], jobs: [], reasons: {} };

test("a pool fleet script change reaches only the fast job's tests", () => {
  // #1759: the fleet scripts and their tests run in the fast job's release checks.
  assert.deepEqual(
    select([
      "scripts/pool-fleet/accept.ts",
      "scripts/pool-fleet/dispatch.ts",
      "scripts/pool-fleet/dispatch.test.ts",
      "scripts/pool-fleet/environment.ts",
      "scripts/pool-fleet/environment.test.ts",
      "scripts/pool-fleet/test/harness.ts",
    ]),
    { declaredFiles: [], jobs: [], reasons: {} },
  );
});

test("a pool runtime fleet change runs the jobs that import or run the pool Worker", () => {
  // #1762: the controller reaches the pool Worker, which the pool runtime tests, the Cloud pool
  // scenarios, the scenarios declaring src/pool inputs and one upstream route test run. Its test
  // and model are fast-only.
  const selected = select([
    "src/pool/runtime-fleet/controller.ts",
    "src/pool/runtime-fleet/failures.ts",
    "src/pool/runtime-fleet-routing.test.ts",
    "architecture/model/pool-runtime-slots.c4",
  ]);
  assert.deepEqual(selected.jobs, [
    "host-managed-accounts-pool",
    "host-managed-accounts-pool-actions",
    "host-managed-accounts-runtime",
    "pool-account-recovery",
    "human-in-the-loop",
    "pool-inventory",
    "pool-runtime",
    "production-build",
    "declared-cloud",
    // The pool organization check's route test runs the pool Worker against the prepared upstream.
    "upstream-contracts",
  ]);
  // Only the scenarios it reaches are planned, so declared-cloud runs a few shards, not twelve.
  assert.ok(selected.declaredFiles?.includes("pool-empty-home.spec.ts"));
  assert.ok(!selected.declaredFiles?.includes("native-tunnel.spec.ts"));
});

test("a Home carry builds only the pool image's own job", () => {
  // pool-runtime's "Build the pinned pool image" step builds containers/pool, whose Dockerfile
  // copies these carries; no other Check job builds that image.
  const entries = jobEntries(root, readWorkflow(root), trackedFiles(root));
  assert.ok(entries["pool-runtime"]!.has(homeCarry));
  assert.deepEqual(
    heavyJobs.filter((job) => entries[job]?.has(homeCarry)),
    ["pool-runtime"],
  );
  assert.deepEqual(select([homeCarry]).jobs, ["pool-runtime"]);
});

test("documentation selects no heavy job", () => {
  assert.deepEqual(select(["docs/pools.md"]), { declaredFiles: [], jobs: [], reasons: {} });
});

test("a path nothing declares or reaches selects every heavy job", () => {
  // A new kind of file at the root, and a deleted code file, whose importers are gone.
  for (const path of ["new-tool.toml", "src/never-imported.ts"]) {
    const selected = select([path]);
    assert.deepEqual(selected.jobs, heavyJobs, path);
    assert.equal(selected.declaredFiles, null, path);
  }
});

test("source the prepared product imports reaches every job that prepares it", () => {
  // The carried hosted Cloud imports the bulk history coordinator, and preparation copies the pool
  // token contract into the hosted server: every job that runs the product runs them.
  const preparing = heavyJobs.filter((job) => !["client-mobile", "client-desktop"].includes(job));
  for (const path of ["src/pool/model-history/bulk-coordinator.ts", "src/pool/token.ts"]) {
    const selected = select([path]);
    for (const job of preparing) assert.ok(selected.jobs.includes(job), path + " " + job);
  }
});

test("job inputs come from the workflow's own steps", () => {
  const entries = jobEntries(root, readWorkflow(root), trackedFiles(root));
  assert.ok(entries["planetscale-sign-in"]!.has("e2e/browser-fixture-certificate-trust.test.ts"));
  assert.ok(entries["host-managed-accounts"]!.has("scripts/pool-ui-tests/accounts-ready.test.mjs"));
  assert.ok(entries["pool-runtime"]!.has("scripts/ci/pool-test-shard.ts"));
  assert.ok(entries["upstream-contracts"]!.has("scripts/upstream-tests/pool-framework.test.ts"));
  // `npm run check:releases` expands to the fleet tests' glob.
  assert.ok(entries.fast!.has("scripts/pool-fleet/dispatch.test.ts"));
  for (const job of heavyJobs) assert.ok(entries[job]?.size, job);
  // A working directory and the files a step only writes are not its inputs.
  assert.ok(!entries.select!.has("scripts/architecture/package.json"));
});

test("the import graph follows imports, re-exports, literal loads and spawned scripts", () => {
  const references = sourceReferences(
    "scripts/example.ts",
    [
      'import { a } from "./a.ts";',
      'import type { B } from "./b.ts";',
      'export { c } from "./c.ts";',
      'export type { D } from "./d.ts";',
      'await import("./e.ts");',
      'new URL("../f.json", import.meta.url);',
      'const worker = "../../src/g.ts";',
      'readFileSync(join(root, "src/h.json"));',
      'spawnSync("node", ["scripts/i.ts", "--flag"]);',
      "const dynamic = await import(name);",
    ].join("\n"),
  );
  assert.deepEqual(references, [
    { kind: "module", specifier: "./a.ts" },
    { kind: "type", specifier: "./b.ts" },
    { kind: "module", specifier: "./c.ts" },
    { kind: "type", specifier: "./d.ts" },
    { kind: "module", specifier: "./e.ts" },
    { kind: "path", specifier: "../f.json" },
    { kind: "path", specifier: "../../src/g.ts" },
    { kind: "path", specifier: "src/h.json" },
    { kind: "spawn", specifier: "scripts/i.ts" },
  ]);
  const { graph } = reach(root);
  // Types are erased: a type-only importer does not depend on the file at runtime.
  const closure = dependents(graph.importers, ["src/pool/runtime-fleet/controller.ts"]);
  assert.ok(closure.has("src/pool/worker.ts"));
  assert.ok(!closure.has("scripts/prepare-upstream.ts"));
});

test("the fast job runs the owned tests a change reaches, wherever they live", () => {
  const tests = ["scripts/ci.test.ts", "src/pool/a.test.ts", "e2e/far.test.ts"];
  assert.deepEqual(selectUnitTests(tests, ["src/pool/a.ts"], ["e2e/far.test.ts"]), tests);
  assert.deepEqual(selectUnitTests(tests, ["src/pool/a.ts"]), tests.slice(0, 2));
});

test("a full run cancels its head's lane run; any run cancels earlier heads' runs", () => {
  const repository = "fixture/repository";
  const run = (id: number, head: string, status = "in_progress", fork = false) => ({
    id,
    head_sha: head,
    status,
    head_repository: { full_name: fork ? "fork/repository" : repository },
  });
  const runs = [
    run(1, "old"),
    run(2, "old", "completed"),
    run(3, "new"),
    run(4, "old", "queued", true),
    run(6, "new"),
  ];
  assert.deepEqual(supersededRuns(runs, { id: 5, head: "new", full: true, repository }), [1, 3]);
  // A lane run never cancels the full run a label started for its own head.
  assert.deepEqual(supersededRuns(runs, { id: 5, head: "new", full: false, repository }), [1]);
});

test("code compiled into untracked output reaches the jobs of its consumers", () => {
  // The artifacts store imports the drive's strata from `.generated`, built from its sources.
  const consumer = select(["src/drive/artifacts/stores.ts"]).jobs;
  const source = select(["src/drive/shared/strata/git/objects.ts"]).jobs;
  for (const job of consumer) assert.ok(source.includes(job), job);
});

test("step scripts split into commands without comments, here-documents or nesting losses", () => {
  assert.deepEqual(
    commands(
      [
        "# Ubuntu's sources",
        "node a.ts # the installer's mirror",
        'cat <<<"$x"',
        "list=$(node b.ts $(node c.ts))",
        "python3 - <<'PY'",
        "import d",
        "PY",
        "node e.ts && node f.ts | tee log",
      ].join("\n"),
    ),
    [
      "node a.ts",
      'cat <<<"$x"',
      "list=$SUBSTITUTED",
      "python3 - <<'PY'",
      "node e.ts",
      "node f.ts",
      "tee log",
      "node c.ts",
      "node b.ts $SUBSTITUTED",
    ],
  );
  // Only the steps the affected lane runs make its fast job's inputs.
  const files = trackedFiles(root);
  const full = jobEntries(root, readWorkflow(root), files);
  const lane = jobEntries(root, readWorkflow(root), files, { lane: true });
  assert.ok(full.fast!.has("scripts/architecture/deployment.ts"));
  assert.ok(!lane.fast!.has("scripts/architecture/deployment.ts"));
});

test("a CI definition change inside one job's block runs only that job", () => {
  // `fast` runs in every Check, so the selection names only the changed heavy job.
  assert.ok(fastJobs.includes("fast"));
  for (const [from, to] of [
    ["      - name: Build the pinned pool image\n", "      - name: Build the pool image\n"],
    [
      "bash scripts/ci/pool-image-build.sh --target runtime --tag basalt-1409-pool:test",
      "bash scripts/ci/pool-image-build.sh --target runtime --tag basalt-1777-pool:test",
    ],
  ]) {
    const inputs = workflowInputs(definition, edit(definition, from!, to!));
    assert.deepEqual(inputs, [".github/workflows/ci.yml#pool-runtime"]);
    assert.deepEqual(select(inputs), {
      declaredFiles: [],
      jobs: ["pool-runtime"],
      reasons: { "pool-runtime": inputs },
    });
  }
  // Parsed blocks are compared, so a comment changes nothing.
  const comment = edit(definition, "  pool-runtime:\n", "  pool-runtime:\n    # A note.\n");
  assert.deepEqual(workflowInputs(definition, comment), []);
  // The comparison commit pair yields the same input as the text comparison.
  const scratch = mkdtempSync(join(tmpdir(), "basalt-ci-definition-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: scratch, encoding: "utf8" }).trim();
  const commit = (text: string) => {
    writeFileSync(join(scratch, ".github/workflows/ci.yml"), text);
    git("add", ".");
    git("commit", "-qm", "workflow");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(scratch, ".github/workflows"), { recursive: true });
    const base = commit(definition);
    const head = commit(edit(definition, "Build the pinned pool image", "Build the pool image"));
    assert.deepEqual(changedInputs(scratch, base, head), {
      changed: [".github/workflows/ci.yml"],
      inputs: [".github/workflows/ci.yml#pool-runtime"],
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a CI definition change outside the job blocks runs every heavy job", () => {
  for (const [from, to] of [
    ["  E2E_BUN_VERSION: 1.4.2\n", "  E2E_BUN_VERSION: 1.4.3\n"],
    [
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
      "  cancel-in-progress: false\n",
    ],
  ]) {
    const inputs = workflowInputs(definition, edit(definition, from!, to!));
    assert.deepEqual(inputs, [".github/workflows/ci.yml"], from);
    const selected = select(inputs);
    assert.deepEqual(selected.jobs, heavyJobs, from);
    assert.equal(selected.declaredFiles, null, from);
  }
  // A side that doesn't parse as a workflow is the whole file too.
  assert.deepEqual(workflowInputs(definition, "jobs: [\n"), [".github/workflows/ci.yml"]);
});

test("a changed job block runs the heavy jobs that need it, with every matrix leg", () => {
  const parsed = parseWorkflow(definition) as unknown as {
    jobs: Record<string, { steps: object[] }>;
  };
  const base = stringify(parsed);
  const changed = (job: string) => {
    const copy = structuredClone(parsed);
    copy.jobs[job]!.steps.push({ run: "true" });
    return select(workflowInputs(base, stringify(copy)));
  };
  // Every heavy job reads select's outputs, and select decides reuse first.
  for (const job of ["select"]) {
    const selected = changed(job);
    assert.deepEqual(selected.jobs, heavyJobs, job);
    assert.equal(selected.declaredFiles, null, job);
  }
  // upstream-image needs workerd-assets, which runs only alongside it.
  assert.deepEqual(changed("workerd-assets").jobs, ["upstream-image"]);
  // A declared job runs all its shards; the aggregate and fast jobs run in every Check.
  assert.deepEqual(changed("declared-cloud"), {
    declaredFiles: null,
    jobs: ["declared-cloud"],
    reasons: { "declared-cloud": [".github/workflows/ci.yml#declared-cloud"] },
  });
  for (const job of ["fast", "check"]) assert.deepEqual(changed(job), nothing, job);
});

test("selection and gate scripts run only the fast job, which tests them", () => {
  for (const path of [
    "scripts/ci/affected.ts",
    "scripts/ci/areas.ts",
    "scripts/ci/reach.ts",
    "scripts/ci/select-jobs.ts",
    "scripts/ci/gate.ts",
    "scripts/ci/box-router.ts",
  ])
    assert.deepEqual(select([path]), nothing, path);
  // The lane's fast job lints the workflows, and its unit legs run every CI test for these and for
  // a job block.
  const files = trackedFiles(root);
  const lane = jobEntries(root, readWorkflow(root), files, { lane: true });
  assert.ok(lane.fast!.has("scripts/ci/check-workflows.ts"), "scripts/ci/check-workflows.ts");
  assert.ok(lane["fast-units"]!.has("scripts/ci/unit-tests.ts"), "scripts/ci/unit-tests.ts");
  const owned = [...jobEntries(root, ownedUnitSuite, files).owned!];
  const ciTests = files.filter((file) => /^scripts\/ci(?:-[\w-]+)?\.test\.ts$/.test(file));
  assert.ok(ciTests.includes("scripts/ci.test.ts") && ciTests.length > 30);
  for (const input of ["scripts/ci/affected.ts", ".github/workflows/ci.yml#pool-runtime"]) {
    const selected = selectUnitTests(owned, [input]);
    for (const file of ciTests) assert.ok(selected.includes(file), input + " " + file);
  }
});

test("setup and preparation tooling every job executes still runs every heavy job", () => {
  for (const path of [
    "scripts/prepare-upstream.ts",
    "scripts/ci/declarations.ts",
    "scripts/ci/setup-node.mjs",
    "scripts/architecture/bun.lock",
  ]) {
    const selected = select([path]);
    assert.deepEqual(selected.jobs, heavyJobs, path);
    assert.equal(selected.declaredFiles, null, path);
  }
});
