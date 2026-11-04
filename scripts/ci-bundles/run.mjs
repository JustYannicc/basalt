import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "./command.mjs";
import { interpolate, partitionSuites, readWorkflow, selectedJobs, suitePlan } from "./plan.mjs";
import { Resources } from "./resources.mjs";
import { runQueue } from "./queue.mjs";
import { collect } from "./artifacts.mjs";

const gib = 1024 ** 3;
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const directory = join(process.env.RUNNER_TEMP, "basalt-boat");
const output = join(directory, "output");
const workflow = readWorkflow(root);
const ids = selectedJobs(process.env.BASALT_CI_BOAT_JOBS ?? "", workflow);
assert.ok(ids.length, "The bundle requires at least one selected job");
const shard = Number(process.env.BASALT_CI_BOAT_SHARD);
assert.ok([1, 2, 3].includes(shard), "Boat shard must be 1, 2 or 3");
const configured = Number(process.env.BASALT_CI_BOAT_MAX_PARALLEL || 2);
assert.ok(Number.isSafeInteger(configured) && configured > 0, "Boat parallelism must be a positive integer");
const concurrency = Math.max(1, Math.min(2, configured, Math.floor(cpus().length / 2), Math.floor((totalmem() - 2 * gib) / (6 * gib))));
const suites = partitionSuites(suitePlan(workflow, ids))[shard - 1];
const results = [];
await mkdir(output, { recursive: true });
await writeFile(join(output, "machine.json"), JSON.stringify({ shard, concurrency,
  cpuCount: cpus().length, totalBytes: totalmem(), suites: suites.map((suite) => suite.key) }, null, 2));
const monitor = new Resources(join(output, "resources.ndjson"));
const started = Date.now();
const baseEnvironment = { ...process.env,
  PATH: `${join(process.env.RUNNER_TEMP, "basalt-bun", "1.4.2")}:${process.env.PATH}` };

async function bootstrap() {
  const commands = [
    [root, "npm run prepare:upstream"],
    [join(root, ".upstream"), "node e2e/check-boundary.ts"],
    [join(root, ".upstream"), "bun run e2e:prepare"],
    [join(root, ".upstream"), "bunx playwright install --with-deps chromium"],
  ];
  for (const [cwd, text] of commands) {
    const result = await command("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", text], {
      cwd, env: baseEnvironment,
      timeoutMs: Math.max(1, Math.max(...suites.map((suite) => suite.timeoutMs)) - (Date.now() - started)),
      log: join(output, "preparation.log"), monitor, suite: "shared-preparation",
    });
    assert.equal(result.code, 0, `Shared preparation failed: ${text}`);
  }
  return Date.now() - started;
}

async function runSuite(suite, preparationMs) {
  const suiteStarted = Date.now();
  const destination = join(output, suite.key);
  const workspace = join(directory, "workspaces", suite.key);
  // Chromium adds socket paths beneath TMPDIR; keep this private base short.
  const temp = await mkdtemp("/tmp/bci-");
  const context = { matrix: suite.matrix, env: suite.env, temp, baseSha: process.env.BASALT_CI_BASE_SHA };
  const steps = [];
  const record = { id: suite.id, key: suite.key, bun: suite.bun,
    startedAt: new Date().toISOString(), status: "failed", steps };
  await mkdir(destination, { recursive: true });
  const persist = () => writeFile(join(destination, "summary.json"), JSON.stringify({ ...record,
    seconds: (Date.now() - suiteStarted) / 1_000, resources: monitor.suites.get(suite.key) }, null, 2));
  record.status = "running";
  await persist();
  await mkdir(workspace, { recursive: true });
  await mkdir(temp, { recursive: true });
  const env = { ...baseEnvironment, ...suite.env, TMPDIR: temp, RUNNER_TEMP: temp,
    PATH: `${join(process.env.RUNNER_TEMP, "basalt-bun", suite.bun)}:${process.env.PATH}` };
  const deadline = suiteStarted + suite.timeoutMs - preparationMs;
  try {
    // Proof runners rewrite prepared source in place, so concurrent suites cannot share it.
    const copied = await command("cp", ["-a", "--reflink=auto", `${root}/.`, workspace], {
      cwd: root, env, timeoutMs: Math.max(1, deadline - Date.now()),
      log: join(destination, "suite.log"), monitor, suite: suite.key,
    });
    assert.equal(copied.code, 0, "Private workspace copy failed");
    for (const step of suite.steps) {
      const name = step.name ?? step.run.split("\n")[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Original ${suite.timeoutMs / 60_000}-minute job deadline exceeded`);
      const commandText = interpolate(step.run, context);
      const stepEnv = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, interpolate(value, context)]));
      const stepStarted = Date.now();
      await appendFile(join(destination, "suite.log"), `\n${name}\n`);
      const result = await command("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", commandText], {
        cwd: join(workspace, step["working-directory"] ?? "."), env: { ...env, ...stepEnv },
        timeoutMs: Math.min(remaining, (step["timeout-minutes"] ?? Infinity) * 60_000),
        log: join(destination, "suite.log"), monitor, suite: suite.key,
      });
      steps.push({ name, ...result, seconds: (Date.now() - stepStarted) / 1_000 });
      await persist();
      if (result.code !== 0) throw new Error(`${name}: ${result.timedOut ? "timed out" : `exit ${result.code}`}`);
    }
    record.status = "passed";
  } catch (error) {
    record.status = "failed";
    record.failure = error.message;
    console.log(`::error title=${suite.key}::${String(error.message).replaceAll("\n", " ").replaceAll("%", "%25")}`);
  } finally {
    try { await collect(suite, workspace, context, destination); }
    catch (error) {
      record.status = "failed";
      record.artifactFailure = error.message;
      record.failure ??= `Artifact collection: ${error.message}`;
      console.log(`::error title=${suite.key}::Artifact collection failed`);
    }
    record.seconds = (Date.now() - suiteStarted) / 1_000;
    record.resources = monitor.suites.get(suite.key);
    await writeFile(join(destination, "summary.json"), JSON.stringify(record, null, 2));
    results.push(record);
    console.log(`${suite.key}: ${record.status} (${record.seconds.toFixed(1)}s)`);
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### ${suite.key}: ${record.status}\n\n${record.failure ?? "All original steps passed."}\n\n`);
    await appendFile(process.env.GITHUB_OUTPUT, `${suite.key}=true\n`);
    await rm(workspace, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
}

try {
  console.log(`Running ${suites.length} suites with at most ${concurrency} processes on ${cpus().length} CPUs and ${(totalmem() / gib).toFixed(1)} GiB`);
  const preparationMs = suites.length ? await bootstrap() : 0;
  const failures = await runQueue(suites, concurrency, (suite) => runSuite(suite, preparationMs));
  for (const failure of failures) {
    console.log(`::error title=Boat worker::${failure.error.message}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.log(`::error title=Boat preparation::${error.message}`);
  process.exitCode = 1;
} finally {
  monitor.close();
  for (const suite of suites.filter((suite) => !results.some((result) => result.key === suite.key))) {
    const destination = join(output, suite.key);
    const record = { id: suite.id, key: suite.key, status: "blocked", failure: "Bundle preparation or worker failed" };
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "summary.json"), JSON.stringify(record, null, 2));
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### ${suite.key}: blocked\n\n${record.failure}\n\n`);
    await appendFile(process.env.GITHUB_OUTPUT, `${suite.key}=true\n`);
    results.push(record);
  }
  const report = { wallSeconds: (Date.now() - started) / 1_000, concurrency,
    resources: monitor.report(), results };
  await writeFile(join(output, "bundle.json"), JSON.stringify(report, null, 2));
  if (report.resources.kernelOomKills || report.resources.oomContainers.length) {
    console.log("::error title=Boat memory::An OOM kill occurred in the bundle");
    process.exitCode = 1;
  }
  if (results.length !== suites.length || results.some((suite) => suite.status !== "passed")) process.exitCode = 1;
}
