import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { coverageErrors, coverageInventory, type ExceptionGroup } from "./ci/e2e-coverage.ts";
import { readDeclarations } from "./ci/declarations.ts";
import { type Workflow } from "./ci/e2e-workflow.ts";
import { filesForTarget, scenarios } from "../.upstream/e2e/test-plan.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));
const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const readWorkflow = () =>
  parse(readFileSync(join(repository, ".github/workflows/ci.yml"), "utf8")) as Workflow;
const baseline = () =>
  JSON.parse(
    readFileSync(join(repository, "scripts/ci/e2e-exceptions.json"), "utf8"),
  ) as ExceptionGroup[];
const realInventory = (workflow = readWorkflow()) =>
  coverageInventory(repository, readDeclarations(repository), workflow, scenarios, filesForTarget);

function fixture(
  run: (
    root: string,
    workflow: Workflow,
    inventory: () => ReturnType<typeof realInventory>,
  ) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "basalt-e2e-coverage-"));
  const write = (path: string, value: unknown) =>
    writeFileSync(join(root, path), JSON.stringify(value));
  for (const path of ["scripts/ci", ".upstream/e2e/tests", "e2e/plans"])
    mkdirSync(join(root, path), { recursive: true });
  symlinkSync(
    join(repository, ".upstream/node_modules"),
    join(root, ".upstream/node_modules"),
    "dir",
  );
  write(".upstream/package.json", {});
  write("package.json", { scripts: {} });
  write("scripts/ci/inherited-tests.json", { manualTargets: {} });
  write("scripts/ci/e2e-groups.json", {
    "declared:self-host": {
      job: "declared-self-host",
      target: "self-host",
      mode: "managed",
      matrix: true,
    },
  });
  const plan = {
    file: "first.spec.ts",
    title: "A selected case",
    targets: {
      "self-host": { status: "scheduled" },
      local: { status: "not-applicable" },
      cloud: { status: "not-applicable" },
    },
  };
  write("e2e/plans/first.spec.ts.json", {
    scenarios: { first: plan },
    runs: { first: ["declared:self-host"] },
  });
  const selectedSource = 'import { test } from "vitest"; test(scenarios.first.title, () => {});\n';
  writeFileSync(join(root, ".upstream/e2e/tests/first.spec.ts"), selectedSource);
  const workflow: Workflow = {
    jobs: {
      "declared-self-host": {
        strategy: {
          matrix: "${{ fromJSON(needs.select.outputs.matrices)['declared-self-host'] }}",
        },
        steps: [
          { run: 'bun scripts/ci/run-declared.ts "${{ matrix.group }}" "${{ matrix.file }}"' },
        ],
      },
    },
  };
  const inventory = () =>
    coverageInventory(
      root,
      readDeclarations(root),
      workflow,
      { first: plan },
      (target, _suite, _mode, pattern) =>
        target === "self-host" && new RegExp(pattern ?? "").test(plan.title)
          ? ["e2e/tests/first.spec.ts"]
          : [],
    );
  try {
    run(root, workflow, inventory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a new literal, aliased, parameterized or unknown dynamic test in a selected spec fails by name", () =>
  fixture((root, _workflow, inventory) => {
    for (const extra of [
      'test("New ungated case", () => {});',
      'import { test as check } from "vitest"; check("New ungated case", () => {});',
      'test.each([1,2])("New ungated case", () => {});',
      'import * as v from "vitest"; v.test("New ungated case", () => {});',
      'const check = test; check("New ungated case", () => {});',
      'import * as v from "vitest"; const check = v.test; check("New ungated case", () => {});',
      'import * as v from "vitest"; const { test: check } = v; check("New ungated case", () => {});',
      'const custom = { ...scenarios.first, title: "New ungated case" }; test(custom.title, () => {});',
      "test(`New ${value}`, () => {});",
      'test(scenarios.first.title + " suffix", () => {});',
    ]) {
      writeFileSync(
        join(root, ".upstream/e2e/tests/first.spec.ts"),
        "test(scenarios.first.title, () => {});\n" + extra,
      );
      const errors = coverageErrors(inventory(), []);
      assert.equal(errors.length, 1, extra);
      assert.match(errors[0]!, /Ungated E2E: first.spec.ts#/);
      assert.match(errors[0]!, /CI group\/job, or add a reviewed exception/);
    }
  }));

test("a new spec with no declared plan cannot inherit another spec's coverage", () =>
  fixture((root, _workflow, inventory) => {
    writeFileSync(
      join(root, ".upstream/e2e/tests/second.spec.ts"),
      'test("Orphaned file", () => {});',
    );
    assert.match(coverageErrors(inventory(), [])[0]!, /second.spec.ts#Orphaned file/);
  }));

test("deleted runner steps, disabled steps and disconnected matrices lose coverage", () =>
  fixture((_root, workflow, inventory) => {
    const job = workflow.jobs["declared-self-host"]!;
    assert.deepEqual(coverageErrors(inventory(), []), []);
    const step = job.steps![0]!;
    step.if = false;
    assert.match(coverageErrors(inventory(), [])[0]!, /first.spec.ts#first/);
    delete step.if;
    step.run = 'echo \'bun scripts/ci/run-declared.ts "${{ matrix.group }}" "${{ matrix.file }}"\'';
    assert.match(coverageErrors(inventory(), [])[0]!, /first.spec.ts#first/);
    step.run =
      'node --version # bun scripts/ci/run-declared.ts "${{ matrix.group }}" "${{ matrix.file }}"';
    assert.match(coverageErrors(inventory(), [])[0]!, /first.spec.ts#first/);
    step.run = 'bun scripts/ci/run-declared.ts "${{ matrix.group }}" "${{ matrix.file }}"';
    for (const condition of [false, "false", "${{ false }}", "${{ 1 == 2 }}"]) {
      job.if = condition;
      assert.match(coverageErrors(inventory(), [])[0]!, /first.spec.ts#first/);
    }
    delete job.if;
    job.strategy!.matrix = { include: [] };
    assert.match(coverageErrors(inventory(), [])[0]!, /first.spec.ts#first/);
  }));

test("recipe checks require an executed runner; an unused string or comment cannot claim them", () =>
  fixture((root, workflow, inventory) => {
    writeFileSync(join(root, "e2e/new-recipe-checks.mjs"), 'throw new Error("would run");');
    writeFileSync(join(root, "scripts/unused.ts"), 'const unused = "e2e/new-recipe-checks.mjs";');
    workflow.jobs.recipe = {
      steps: [
        {
          run: "node scripts/unused.ts\necho e2e/new-recipe-checks.mjs\n# node e2e/new-recipe-checks.mjs",
        },
      ],
    };
    assert.match(coverageErrors(inventory(), [])[0]!, /e2e\/new-recipe-checks.mjs/);
    workflow.jobs.recipe.steps!.push({ run: "node e2e/new-recipe-checks.mjs" });
    assert.deepEqual(coverageErrors(inventory(), []), []);
  }));

test("a skipped suite cannot claim its planned children executed", () =>
  fixture((root, _workflow, inventory) => {
    for (const prefix of ["describe.skip", "suite.skip", "describe.skipIf(true)"]) {
      writeFileSync(
        join(root, ".upstream/e2e/tests/first.spec.ts"),
        `${prefix}("Skipped suite", () => { test(scenarios.first.title, () => {}); });`,
      );
      assert.match(coverageErrors(inventory(), [])[0]!, /first.spec.ts#first/);
    }
  }));

test("syntax checks, argv data, comments and type-only imports do not execute a recipe", () =>
  fixture((root, workflow, inventory) => {
    writeFileSync(join(root, "e2e/new-recipe-checks.mjs"), 'console.log("proof");');
    writeFileSync(
      join(root, "scripts/wrapper.ts"),
      'import { spawn } from "node:child_process"; spawn("echo", ["e2e/new-recipe-checks.mjs"]);',
    );
    writeFileSync(
      join(root, "scripts/type-only.ts"),
      'import type { Proof } from "../e2e/new-recipe-checks.mjs";',
    );
    for (const run of [
      "node --check e2e/new-recipe-checks.mjs",
      "node scripts/wrapper.ts e2e/new-recipe-checks.mjs",
      "node scripts/wrapper.ts # e2e/new-recipe-checks.mjs",
      "node scripts/type-only.ts",
    ]) {
      workflow.jobs.recipe = { steps: [{ run }] };
      assert.match(coverageErrors(inventory(), [])[0]!, /Ungated E2E: e2e\/new-recipe-checks.mjs/);
    }
  }));

test("a config must include the test in executable data rather than a comment", () =>
  fixture((root, workflow, inventory) => {
    writeFileSync(
      join(root, "e2e/plans/config.spec.ts.json"),
      JSON.stringify({
        scenarios: {},
        runs: {},
        config: [{ job: "fast", config: "guard.config.ts" }],
      }),
    );
    writeFileSync(
      join(root, ".upstream/e2e/tests/config.spec.ts"),
      'test("Config case", () => {});',
    );
    const config = join(root, ".upstream/e2e/guard.config.ts");
    writeFileSync(config, "export default { test: { include: [] } }; // e2e/tests/config.spec.ts");
    workflow.jobs.fast = { steps: [{ run: "bunx vitest run --config e2e/guard.config.ts" }] };
    assert.ok(
      coverageErrors(inventory(), []).some((error) => error.includes("config.spec.ts#Config case")),
    );
    writeFileSync(config, 'export default { test: { include: ["e2e/tests/config.spec.ts"] } };');
    assert.deepEqual(coverageErrors(inventory(), []), []);
  }));

test("a selector mentioned in another command cannot replace the runner's actual filter", () =>
  fixture((root, workflow, inventory) => {
    writeFileSync(
      join(root, "scripts/ci/e2e-groups.json"),
      JSON.stringify({
        "declared:self-host": { job: "declared-self-host", target: "self-host", mode: "managed" },
      }),
    );
    const step = workflow.jobs["declared-self-host"]!.steps![0]!;
    step.run =
      'bun run e2e:self-host --test-name "Nothing matches"\necho "$(node scripts/ci/e2e-pattern.ts declared:self-host)"';
    assert.match(coverageErrors(inventory(), [])[0]!, /first.spec.ts#first/);
    step.run =
      'bun run e2e:self-host --test-name "$(node scripts/ci/e2e-pattern.ts declared:self-host)"';
    assert.deepEqual(coverageErrors(inventory(), []), []);
  }));

test("reviewed exceptions bind source changes and expire as soon as their runner is wired", () =>
  fixture((root, workflow, inventory) => {
    const file = join(root, "e2e/pool-recipe-checks.mjs");
    writeFileSync(file, 'console.log("synthetic proof");');
    const record = inventory().find((item) => item.id === "e2e/pool-recipe-checks.mjs")!;
    const exceptions = [
      {
        reason: "Temporary #578: owner fixes this runner",
        entries: { [record.id]: record.fingerprint },
      },
    ];
    assert.deepEqual(coverageErrors(inventory(), exceptions), []);
    writeFileSync(file, 'console.log("changed proof");');
    assert.match(coverageErrors(inventory(), exceptions)[0]!, /needs re-review/);
    workflow.jobs.recipe = { steps: [{ run: "node e2e/pool-recipe-checks.mjs" }] };
    assert.match(coverageErrors(inventory(), exceptions)[0]!, /Remove stale E2E exception/);
  }));

test("an inherited test cannot grow silently under its existing exception", () =>
  fixture((root, _workflow, inventory) => {
    const file = join(root, ".upstream/e2e/tests/inherited.spec.ts");
    writeFileSync(file, 'test("Kept inherited case", () => {});');
    const record = inventory().find((item) => item.id.includes("Kept inherited case"))!;
    const exceptions = [
      { reason: "Reviewed inherited baseline", entries: { [record.id]: record.fingerprint } },
    ];
    assert.deepEqual(coverageErrors(inventory(), exceptions), []);
    writeFileSync(
      file,
      'test("Kept inherited case", () => {}); test("New hidden case", () => {});',
    );
    const errors = coverageErrors(inventory(), exceptions);
    assert.ok(errors.some((error) => error.includes("needs re-review")));
    assert.ok(
      errors.some((error) => error.includes("Ungated E2E: inherited.spec.ts#New hidden case")),
    );
  }));

test("the fast lane checks all current omissions and the known compact row stays selected", () => {
  const records = realInventory();
  assert.deepEqual(coverageErrors(records, baseline()), []);
  assert.ok(
    records.find(
      (record) => record.id === "listed-account-bindings.spec.ts#listedBindingCompactRow",
    )?.selected,
  );
  const recipe = records.find((record) => record.id === "e2e/pool-recipe-checks.mjs")!;
  assert.ok(recipe.selected);
  const errors = coverageErrors(records, []);
  assert.ok(errors.some((error) => error.includes("tool-call-batch.spec.ts#toolCallBatch")));
  const workflow = readWorkflow();
  assert.ok(
    workflow.jobs.fast!.steps!.some(
      (step) => step.run === "bun scripts/ci/check-e2e-coverage.ts" && step.if === undefined,
    ),
  );
  assert.ok(
    coverageErrors(records, [
      ...baseline(),
      { reason: "Stale #578 baseline", entries: { [recipe.id]: recipe.fingerprint } },
    ]).some((error) =>
      error.includes("Remove stale E2E exception now selected by CI: e2e/pool-recipe-checks.mjs"),
    ),
  );
});
