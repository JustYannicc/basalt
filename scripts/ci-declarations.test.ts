import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  declaredMatrices,
  matchingDeclarations,
  patternForGroup,
  prepareTestPlans,
  readDeclarations,
} from "./ci/declarations.ts";
import { selectPaths } from "./ci/affected.ts";
import { heavyJobs } from "./ci/areas.ts";

const scenario = (title: string) => ({
  title,
  targets: {
    "self-host": { status: "scheduled" },
    local: { status: "not-applicable", reason: "Hosted fixture" },
    cloud: { status: "not-applicable", reason: "Hosted fixture" },
  },
});
const withFixture = (
  run: (root: string, write: (file: string, value: unknown) => void) => void,
) => {
  const root = mkdtempSync(join(tmpdir(), "basalt-test-plans-"));
  const write = (file: string, value: unknown) =>
    writeFileSync(join(root, file), JSON.stringify(value));
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  mkdirSync(join(root, "e2e/plans"), { recursive: true });
  write("scripts/ci/inherited-tests.json", { manualTargets: {} });
  write("scripts/ci/e2e-groups.json", {
    "declared:self-host": {
      job: "declared-self-host",
      target: "self-host",
      mode: "managed",
      matrix: true,
    },
  });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/first.ts"), "export const first = true;\n");
  writeFileSync(join(root, "src/second.ts"), "export const second = true;\n");
  write("upstream.json", { commit: "a".repeat(40) });
  write("scripts/ci/upstream-files.json", { pin: "a".repeat(40), files: [] });
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=ci@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Frozen source",
    ],
  ])
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    run(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("an explicitly unrun scenario keeps its plan without claiming a running job", () =>
  withFixture((root, write) => {
    const plan = scenario("Waiting for Cloud parity");
    const deferred = {
      ...plan,
      targets: {
        ...plan.targets,
        "self-host": { status: "not-run", reason: "Tracked parity failure" },
      },
    };
    write("e2e/plans/first.spec.ts.json", {
      scenarios: { first: deferred },
      runs: { first: [] },
      inputs: ["src/first.ts"],
    });
    assert.deepEqual(readDeclarations(root).files["first.spec.ts"]!.runs.first, []);
    assert.deepEqual(declaredMatrices(null, root)["declared-self-host"]!.include, []);
    write("e2e/plans/first.spec.ts.json", {
      scenarios: { first: plan },
      runs: { first: [] },
      inputs: ["src/first.ts"],
    });
    assert.throws(() => readDeclarations(root), /invalid scenario assignment/);
  }));

test("adding a per-file plan extends existing groups and preserves exact scenario names", () =>
  withFixture((root, write) => {
    const first = "Account (personal) uses $5?";
    const second = "A second file has a separate test";
    write("e2e/plans/first.spec.ts.json", {
      scenarios: { first: scenario(first) },
      runs: { first: ["declared:self-host"] },
      inputs: ["src/first.ts"],
    });
    write("e2e/plans/second.spec.ts.json", {
      scenarios: { second: scenario(second) },
      runs: { second: ["declared:self-host"] },
      inputs: ["src/second.ts"],
    });
    const selected = new RegExp(patternForGroup("declared:self-host", "first.spec.ts", root));
    assert.ok(selected.test(first));
    assert.ok(!selected.test(second));
    assert.ok(!selected.test(first + " extra"));
    assert.ok(!selected.test("Account personal uses 5"));
    const declarations = readDeclarations(root);
    assert.deepEqual(
      matchingDeclarations("src/first.ts", declarations).map((item) => item.file),
      ["first.spec.ts"],
    );
    assert.deepEqual(matchingDeclarations("src/unrelated.ts", declarations), []);
    assert.equal(
      declaredMatrices(["first.spec.ts"], root)["declared-self-host"]!.include.length,
      1,
    );
    assert.equal(prepareTestPlans(root, join(root, "prepared")), 2);
    const plans = JSON.parse(readFileSync(join(root, "prepared/e2e/basalt-plans.json"), "utf8"));
    assert.equal(plans.first.file, "first.spec.ts");
    assert.equal(plans.second.title, second);
  }));

test("unmapped cases, unknown jobs and incompatible targets fail closed", () =>
  withFixture((root, write) => {
    const path = "e2e/plans/first.spec.ts.json";
    write(path, { scenarios: { first: scenario("First") }, runs: {} });
    assert.throws(() => readDeclarations(root), /no CI job/);
    write(path, { scenarios: { first: scenario("First") }, runs: { first: ["missing"] } });
    assert.throws(() => readDeclarations(root), /Unknown e2e group/);
    write("scripts/ci/e2e-groups.json", {
      cloud: { job: "declared-cloud", target: "cloud", mode: "managed", matrix: true },
    });
    write(path, { scenarios: { first: scenario("First") }, runs: { first: ["cloud"] } });
    assert.throws(() => readDeclarations(root), /runtime does not match/);
    write("scripts/ci/e2e-groups.json", {
      invalid: { job: "unknown", target: "cloud", mode: "managed" },
    });
    assert.throws(() => readDeclarations(root), /Unknown declared job/);
  }));

test("an affected telemetry declaration selects its file rather than every newly adopted scenario", () => {
  const selected = selectPaths([".upstream/e2e/tests/telemetry-relay.spec.ts"]);
  assert.ok(selected.jobs.includes("declared-cloud"));
  const matrix = declaredMatrices(selected.declaredFiles)["declared-cloud"]!.include;
  assert.deepEqual(
    matrix.map((item) => item.file),
    ["telemetry-relay.spec.ts"],
  );
  assert.ok(!selected.jobs.includes("declared-self-host"));
});

test("an unrun Maps declaration cannot establish runtime coverage", () => {
  const selected = selectPaths(["src/catalog/google-maps/hosted-routes.ts"]);
  assert.deepEqual(selected.jobs, heavyJobs);
  assert.equal(selected.declaredFiles, null);
  const matrix = declaredMatrices(selected.declaredFiles)["declared-cloud"]!.include;
  assert.ok(!matrix.some((item) => item.file === "hosted-routes.spec.ts"));
});

test("undeclared E2E helpers retain every heavy job and every declaration matrix", () => {
  const all = declaredMatrices();
  for (const path of [
    ".upstream/e2e/support/account-family-product.ts",
    ".upstream/e2e/support/account-rows.ts",
    ".upstream/e2e/fixtures/google-provider-declarations.json",
  ]) {
    const selected = selectPaths([path]);
    assert.deepEqual(selected.jobs, heavyJobs, path);
    assert.equal(selected.declaredFiles, null, path);
    assert.deepEqual(declaredMatrices(selected.declaredFiles), all, path);
  }
  assert.ok(
    all["declared-local"]!.include.some(
      (entry) => entry.file === "account-identity-screens.spec.ts",
    ),
  );
  assert.ok(
    Object.values(all).some((matrix) =>
      matrix.include.some((entry) => entry.file === "account-directory-health.spec.ts"),
    ),
  );
});

test("every scheduled target requires a runner, with explicit inherited attached exceptions", () =>
  withFixture((root, write) => {
    const plan = scenario("Both hosted targets");
    const targets = { ...plan.targets, cloud: { status: "scheduled", runtime: "attached" } };
    write("e2e/plans/first.spec.ts.json", {
      scenarios: { first: { ...plan, targets } },
      runs: { first: ["declared:self-host"] },
    });
    assert.throws(() => readDeclarations(root), /scheduled target has no CI job/);
    write("scripts/ci/inherited-tests.json", {
      manualTargets: {
        first: {
          file: "first.spec.ts",
          target: "cloud",
          runtime: "attached",
          reason: "A deployed stage is required",
          command: "bun run e2e:deployed",
        },
      },
    });
    assert.equal(Object.keys(readDeclarations(root).manualTargets).length, 1);
    write("e2e/plans/first.spec.ts.json", {
      scenarios: { first: { ...plan, targets: { ...targets, cloud: { status: "scheduled" } } } },
      runs: { first: ["declared:self-host"] },
    });
    assert.throws(() => readDeclarations(root), /scheduled target has no CI job/);
  }));

test("the coverage CLI rejects a changed inherited image test even with the old bypass field", () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "basalt-coverage-"));
  try {
    execFileSync(
      "git",
      ["clone", "--quiet", "--shared", "--no-checkout", "--single-branch", repository, root],
      { stdio: "pipe" },
    );
    for (const path of ["e2e", "scripts/ci", ".github/workflows"])
      mkdirSync(join(root, path), { recursive: true });
    cpSync(join(repository, "e2e/plans"), join(root, "e2e/plans"), { recursive: true });
    cpSync(
      join(repository, "scripts/ci/e2e-groups.json"),
      join(root, "scripts/ci/e2e-groups.json"),
    );
    cpSync(join(repository, ".github/workflows/ci.yml"), join(root, ".github/workflows/ci.yml"));
    cpSync(join(repository, "upstream.json"), join(root, "upstream.json"));
    cpSync(
      join(repository, "scripts/ci/upstream-files.json"),
      join(root, "scripts/ci/upstream-files.json"),
    );
    symlinkSync(join(repository, ".upstream"), join(root, ".upstream"), "dir");
    const inventory = JSON.parse(
      readFileSync(join(repository, "scripts/ci/inherited-tests.json"), "utf8"),
    );
    inventory.files["docker-release.spec.ts"] = execFileSync(
      "git",
      ["-C", join(repository, ".upstream"), "rev-parse", "HEAD:e2e/tests/docker-release.spec.ts"],
      { encoding: "utf8" },
    ).trim();
    inventory.releaseOnly = { "docker-release.spec.ts": "Old bypass must have no effect" };
    writeFileSync(join(root, "scripts/ci/inherited-tests.json"), JSON.stringify(inventory));
    rmSync(join(root, "e2e/plans/docker-release.spec.ts.json"));
    const result = spawnSync("bun", [join(repository, "scripts/ci/check-plans.ts")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Changed inherited test needs a declaration/);
    cpSync(
      join(repository, "e2e/plans/docker-release.spec.ts.json"),
      join(root, "e2e/plans/docker-release.spec.ts.json"),
    );
    const upstream = JSON.parse(readFileSync(join(root, "scripts/ci/upstream-files.json"), "utf8"));
    upstream.files.push("packages/sdk/nonexistent-source.ts");
    writeFileSync(join(root, "scripts/ci/upstream-files.json"), JSON.stringify(upstream));
    const stale = spawnSync("bun", [join(repository, "scripts/ci/check-plans.ts")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.ifError(stale.error);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stdout + stale.stderr, /Frozen upstream input inventory differs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
