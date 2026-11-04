import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  declaredMatrices,
  matchingDeclarations,
  patternForGroup,
  prepareTestPlans,
  readDeclarations,
} from "./ci/declarations.ts";
import { selectPaths } from "./ci/affected.ts";

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
  write("scripts/ci/e2e-groups.json", {
    "declared:self-host": {
      job: "declared-self-host",
      target: "self-host",
      mode: "managed",
      matrix: true,
    },
  });
  try {
    run(root, write);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

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

test("an affected Maps declaration selects its file rather than every newly adopted scenario", () => {
  const selected = selectPaths(["src/catalog/google-maps/hosted-routes.ts"]);
  assert.ok(selected.jobs.includes("declared-cloud"));
  const matrix = declaredMatrices(selected.declaredFiles)["declared-cloud"]!.include;
  assert.deepEqual(
    matrix.map((item) => item.file),
    ["hosted-routes.spec.ts"],
  );
  assert.ok(!selected.jobs.includes("declared-self-host"));
});
