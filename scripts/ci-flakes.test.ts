import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { classify, parsePolicy, parseVerdict } from "./ci/flake-policy.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const policy = parsePolicy(JSON.parse(readFileSync(new URL("./ci/tracked-flakes.json", import.meta.url), "utf8")));
const removal = policy.find((entry) => entry.id === "production-ops-remove-400")!;
const physical = policy.find((entry) => entry.id === "physical-database-0165")!;
const removalTest = () => ({
  file: removal.file, title: removal.titles[0], state: "failed",
  errors: [{ name: "FixtureFailed", message: "Fixture /remove failed (HTTP 400)",
    stack: "FixtureFailed: Fixture /remove failed (HTTP 400)\n    at /fixture/e2e/sdk/fixtures.ts:47:23", diff: null }],
  primary: { file: removal.file, title: removal.titles[0], status: "passed", errors: [] },
});
const shutdown = { complete: true, error: false, timedOut: false, uncaught: false, exitCode: 1 };
const verdict = (tests: unknown[]) => ({ version: 1, reason: "failed", unhandledErrors: [], suiteErrors: [], tests, shutdown });
const classifyRemoval = (input: unknown, entries = policy) => classify(parseVerdict(input), entries, removal.job, "");

test("only the reviewed removal failure after a passed body is non-blocking, and deleting its entry restores blocking", () => {
  const input = verdict([removalTest()]);
  assert.equal(classifyRemoval(input)?.[0]?.id, removal.id);
  assert.equal(classifyRemoval(input, policy.filter((entry) => entry.id !== removal.id)), null);
  for (const message of ["Fixture /remove failed (HTTP 401)", "Fixture /create failed (HTTP 400)", "Test timed out"]) {
    const failed = removalTest();
    failed.errors[0]!.message = message;
    assert.equal(classifyRemoval(verdict([failed])), null);
  }
  const primaryFailure = removalTest();
  primaryFailure.primary.status = "failed";
  assert.equal(classifyRemoval(verdict([primaryFailure])), null);
  const twoErrors = removalTest();
  twoErrors.errors.push({ ...twoErrors.errors[0]!, message: "another failure" });
  assert.equal(classifyRemoval(verdict([twoErrors])), null);
  assert.equal(classifyRemoval(verdict([{ ...removalTest(), primary: null }])), null);
});

test("unknown, incomplete, cancelled, setup and unhandled failures remain blocking beside a known flake", () => {
  const input = verdict([removalTest()]);
  for (const field of ["unhandledErrors", "suiteErrors", "tests", "shutdown"]) {
    const missing: Record<string, unknown> = { ...input };
    delete missing[field];
    assert.throws(() => parseVerdict(missing));
  }
  for (const changed of [
    { reason: "interrupted" }, { unhandledErrors: [{ message: "unhandled" }] },
    { suiteErrors: [{ message: "setup failed" }] },
    { tests: [removalTest(), { ...removalTest(), title: "unknown failure" }] },
    { tests: [removalTest(), { ...removalTest(), state: "pending" }] },
    ...[{ complete: false }, { error: true }, { timedOut: true }, { uncaught: true }, { exitCode: null }]
      .map((change) => ({ shutdown: { ...shutdown, ...change } })),
  ]) assert.equal(classifyRemoval({ ...input, ...changed }), null);
});

test("physical flake requires the accounts-only diff at the retained final comparison", () => {
  const diff = `- Expected\n+ Received\n\n  {\n-   "accounts": "${"a".repeat(64)}",\n+   "accounts": "${"b".repeat(64)}",\n    "identity": "same",\n  }`;
  const source = "expect(after.target).toEqual(beforeApply.target);";
  const failed = {
    file: physical.file, title: physical.titles[0], state: "failed", primary: null,
    errors: [{ name: "AssertionError", message: "expected objects to deeply equal", diff,
      stack: "AssertionError\n    at /fixture/e2e/tests/production-ops-database.spec.ts:1:30" }],
  };
  const check = () => classify(parseVerdict(verdict([failed])), policy, physical.job, source);
  assert.equal(check()?.[0]?.id, physical.id);
  failed.errors[0]!.diff = diff + '\n-   "receipts": [],\n+   "receipts": ["unexpected"],';
  assert.equal(check(), null);
  failed.errors[0]!.diff = "";
  assert.equal(check(), null);
  failed.errors[0]!.diff = diff;
  failed.errors[0]!.stack = "AssertionError\n    at /fixture/e2e/tests/production-ops-database.spec.ts:2:30";
  assert.equal(check(), null);
});

test("final reporter records real assertion diffs, suite errors and unhandled errors without changing Vitest's verdict", () => {
  const scratch = mkdtempSync(join(tmpdir(), "basalt-ci-reporter-"));
  try {
    const vitest = resolve(root, ".upstream/node_modules/vitest");
    const reporter = fileURLToPath(new URL("./ci/vitest-verdict.mjs", import.meta.url));
    const output = join(scratch, "report/diagnostics/ci-verdict.json");
    writeFileSync(join(scratch, "probe.spec.mjs"), `
      import { test, expect } from ${JSON.stringify(join(vitest, "dist/index.js"))};
      test("changed checksum", () => expect({ accounts: "b".repeat(64), identity: "same" }).toEqual({ accounts: "a".repeat(64), identity: "same" }));
      test("unhandled failure", () => { process.emit("unhandledRejection", new Error("unhandled probe"), Promise.resolve()); });
    `);
    writeFileSync(join(scratch, "setup.spec.mjs"), `
      import { test, beforeAll } from ${JSON.stringify(join(vitest, "dist/index.js"))};
      beforeAll(() => { throw new Error("setup probe"); });
      test("never runs", () => {});
    `);
    writeFileSync(join(scratch, "vitest.config.mjs"), `export default { test: {
      include: ["*.spec.mjs"], maxWorkers: 1, fileParallelism: false,
      reporters: [[${JSON.stringify(reporter)}, { outputFile: ${JSON.stringify(output)} }]]
    } };`);
    const result = spawnSync(process.execPath, [join(vitest, "vitest.mjs"), "run", "--config", "vitest.config.mjs"],
      { cwd: scratch, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    const report = parseVerdict(JSON.parse(readFileSync(output, "utf8")));
    assert.equal(report.reason, "failed");
    assert.equal(report.unhandledErrors.length, 1);
    assert.ok(report.suiteErrors.length > 0);
    assert.equal(report.shutdown.complete, true);
    assert.equal(report.shutdown.exitCode, 1);
    const error = report.tests.find((test) => test.title === "changed checksum")?.errors[0];
    assert.ok(error?.diff?.includes('"accounts"'), "Final reporter must retain the actual assertion diff");
    writeFileSync(join(scratch, "probe.spec.mjs"), `
      import { test, expect } from ${JSON.stringify(join(vitest, "dist/index.js"))};
      test("body failure", () => expect(1).toBe(2));
    `);
    writeFileSync(join(scratch, "global-setup.mjs"), `export default () => () => { throw new Error("late close probe"); };`);
    writeFileSync(join(scratch, "vitest.config.mjs"), `export default { test: {
      include: ["probe.spec.mjs"], maxWorkers: 1, globalSetup: ["./global-setup.mjs"],
      reporters: [[${JSON.stringify(reporter)}, { outputFile: ${JSON.stringify(output)} }]]
    } };`);
    const late = spawnSync(process.execPath, [join(vitest, "vitest.mjs"), "run", "--config", "vitest.config.mjs"],
      { cwd: scratch, encoding: "utf8" });
    assert.equal(late.status, 1);
    const lateReport = parseVerdict(JSON.parse(readFileSync(output, "utf8")));
    assert.equal(lateReport.shutdown.complete, true);
    assert.equal(lateReport.shutdown.error, true, "Global teardown failure must survive the earlier final report");
    for (const [name, action] of [
      ["late-worker", 'this.context.onClose(() => this.context.state.catchError(new Error("late worker probe"), "Teardown Error"));'],
      ["late-reporter", 'throw new Error("late reporter probe");'],
      ["ordinary-failure", ""],
    ]) {
      writeFileSync(join(scratch, "observer.mjs"), `export default class {
        onInit(context) { this.context = context; }
        onTestRunEnd() { ${action} }
      }`);
      writeFileSync(join(scratch, "vitest.config.mjs"), `export default { test: {
        include: ["probe.spec.mjs"], maxWorkers: 1,
        reporters: [[${JSON.stringify(reporter)}, { outputFile: ${JSON.stringify(output)} }], "./observer.mjs", "verbose"]
      } };`);
      const run = spawnSync(process.execPath, [join(vitest, "vitest.mjs"), "run", "--config", "vitest.config.mjs"],
        { cwd: scratch, encoding: "utf8" });
      assert.equal(run.status, 1);
      const observed = parseVerdict(JSON.parse(readFileSync(output, "utf8")));
      assert.equal(observed.shutdown.complete, true);
      if (name === "late-worker") assert.equal(observed.unhandledErrors.length, 1);
      else assert.equal(observed.shutdown.error, name === "late-reporter", name);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
