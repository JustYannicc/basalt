import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { command } from "./command.mjs";
import { eligibleJobs, interpolate, readWorkflow, selectedJobs, suitePlan } from "./plan.mjs";
import { runQueue } from "./queue.mjs";
import { collect } from "./artifacts.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readWorkflow(root);

test("each selected suite retains its original commands, step deadlines and Bun pin", () => {
  const ids = eligibleJobs(workflow);
  assert.equal(ids.length, 21);
  const suites = suitePlan(workflow, ids);
  assert.equal(suites.length, 28);
  assert.equal(new Set(suites.map((suite) => suite.key)).size, 28);
  for (const suite of suites) {
    const original = workflow.jobs[suite.id];
    assert.equal(suite.timeoutMs, original["timeout-minutes"] * 60_000);
    assert.deepEqual(suite.steps.filter((step) => step["timeout-minutes"]),
      original.steps.filter((step) => step.run && step["timeout-minutes"]));
    const tests = original.steps.filter((step) => step.run &&
      !["npm run prepare:upstream", "bun run e2e:prepare", "bunx playwright install --with-deps chromium"].includes(step.run));
    assert.deepEqual(suite.steps, tests);
    assert.equal(suite.bun, suite.id.startsWith("client-") && suite.id !== "client-native-product" ? "1.4.4" : "1.4.2");
  }
});

test("identity scenarios and Windows exclusion survive bundle expansion", () => {
  const identity = suitePlan(workflow, ["production-ops-identity"]);
  assert.equal(identity.length, 8);
  for (const suite of identity) {
    const step = suite.steps.find((step) => step.env?.BASALT_SCOPE_PROOF_PATTERN);
    assert.equal(interpolate(step.env.BASALT_SCOPE_PROOF_PATTERN,
      { matrix: suite.matrix }), `^Cloud production operations enforce ${suite.matrix.scenario}$`);
  }
  assert.deepEqual(suitePlan(workflow, ["client-desktop"]).map((suite) => suite.matrix.platform), ["linux"]);
  assert.deepEqual(selectedJobs("", workflow), []);
  assert.deepEqual(selectedJobs("production-ops,production-ops", workflow), ["production-ops"]);
  assert.throws(() => selectedJobs("check", workflow), /Unknown Boat job/);
  assert.throws(() => selectedJobs("production-ops-extra", workflow), /Unknown Boat job/);
});

test("a red suite cannot prevent later suites from running or exceed concurrency", async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const failures = await runQueue([1, 2, 3, 4, 5], 2, async (id) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await Promise.resolve();
      completed.push(id);
      if (id === 1 || id === 3) throw new Error(`red ${id}`);
    } finally { active--; }
  });
  assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.deepEqual(failures.map((failure) => failure.item).sort(), [1, 3]);
});

test("the original command deadline terminates the owned process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bundle-command-"));
  try {
    const result = await command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: directory, env: process.env, timeoutMs: 100, log: join(directory, "command.log"),
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    const red = await command(process.execPath, ["-e", "process.exit(17)"], {
      cwd: directory, env: process.env, timeoutMs: 5_000, log: join(directory, "command.log"),
    });
    assert.equal(red.code, 17);
    assert.equal(red.timedOut, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("required missing evidence fails even when the suite summary exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bundle-evidence-"));
  try {
    const output = join(directory, "output");
    await mkdir(output);
    await writeFile(join(output, "summary.json"), "{}");
    const suite = { artifacts: [{ name: "screenshots", path: "screenshots/*.png", "if-no-files-found": "error" }] };
    await assert.rejects(collect(suite, directory, { temp: directory }, output), /Required artifact is missing/);
    await mkdir(join(directory, "screenshots"));
    await assert.rejects(collect({ artifacts: [{ ...suite.artifacts[0], path: "screenshots" }] },
      directory, { temp: directory }, output), /Required artifact is missing/);
    await writeFile(join(directory, "screenshots/proof.png"), "retained-proof");
    await collect(suite, directory, { temp: directory }, output);
    assert.equal(await readFile(join(output, "artifacts/screenshots/proof.png"), "utf8"), "retained-proof");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
