import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { selectPaths } from "./ci/affected.ts";
import { heavyJobs } from "./ci/areas.ts";
import { supersededRuns } from "./ci/cancel-superseded.ts";
import { dependents, sourceReferences, trackedFiles } from "./ci/import-graph.ts";
import { commands, jobEntries, readWorkflow } from "./ci/job-inputs.ts";
import { reach } from "./ci/reach.ts";
import { selectUnitTests } from "./ci/unit-tests.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const select = (paths: string[]) => selectPaths(paths, root);
const homeCarry = "containers/pool/patches/0169-home-oauth-completion-receipts.patch";

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
  // scenarios and the scenarios declaring src/pool inputs run. Its test and model are fast-only.
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
