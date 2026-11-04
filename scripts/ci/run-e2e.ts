import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, parsePolicy, parseVerdict } from "./flake-policy.ts";
import { instrument } from "./instrument.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const upstream = join(root, ".upstream");
const policy = parsePolicy(JSON.parse(readFileSync(new URL("./tracked-flakes.json", import.meta.url), "utf8")));
const [flag, job, separator, command, ...args] = process.argv.slice(2);
assert.ok(flag === "--job" && job && /^[a-z0-9-]+$/.test(job) && separator === "--" && command,
  "usage: run-e2e.ts --job <job> -- <command> [args]");
const evidence = join(upstream, ".local/e2e");
const runs = () => new Set(existsSync(evidence) ? readdirSync(evidence) : []);
const before = runs();
const config = join(upstream, "e2e/vitest.config.ts");
const original = readFileSync(config, "utf8");
const driver = join(upstream, "e2e/run.ts");
const originalDriver = readFileSync(driver, "utf8");
const reporter = fileURLToPath(new URL("./vitest-verdict.mjs", import.meta.url));
const output = join(root, ".generated/ci-flakes");
mkdirSync(output, { recursive: true });
const id = `${job}-${randomUUID()}`;
const driverOutput = join(output, `${id}-driver`);
const processReport = join(output, `${id}-process.json`);
const instrumented = instrument(original, originalDriver, reporter, driverOutput);
let interrupted = false;
let code: number | null = null;
let signal: NodeJS.Signals | null = null;
writeFileSync(config, instrumented.config);
writeFileSync(driver, instrumented.driver);
try {
  const observed = command === "node" ? ["--import", fileURLToPath(new URL("./observe-process.mjs", import.meta.url)), ...args] : args;
  const child = spawn(command, observed, {
    stdio: "inherit", env: { ...process.env, BASALT_CI_PROCESS_REPORT: processReport },
  });
  const interrupt = (received: NodeJS.Signals) => { interrupted = true; child.kill(received); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    ({ code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
} finally {
  assert.equal(readFileSync(config, "utf8"), instrumented.config, "The instrumented configuration changed during the run");
  assert.equal(readFileSync(driver, "utf8"), instrumented.driver, "The instrumented driver changed during the run");
  writeFileSync(config, original);
  writeFileSync(driver, originalDriver);
}

const reports = [...runs()].filter((name) => !before.has(name)).flatMap((name) =>
  ["cloud", "self-host", "local"].map((target) => join(evidence, name, target, "report/diagnostics/ci-verdict.json"))
    .filter(existsSync));
let tracked: NonNullable<ReturnType<typeof classify>> = [];
let blocking = code !== 0;
if (code === 1 && !signal && !interrupted && reports.length > 0 &&
    reports.length === [...runs()].filter((name) => !before.has(name)).length) {
  try {
    const drivers = readdirSync(output).filter((name) => name.startsWith(`${id}-driver.`));
    assert.equal(drivers.length, reports.length, "Every Vitest report needs its completed outer driver");
    for (const name of drivers) {
      const outer = JSON.parse(readFileSync(join(output, name), "utf8"));
      assert.equal(outer.passed, false);
      assert.equal(outer.expectedTestFailure, true, "Outer setup, cleanup and reporting errors remain blocking");
    }
    if (command === "node") {
      const outer = JSON.parse(readFileSync(processReport, "utf8"));
      assert.equal(outer.code, 1);
      assert.equal(outer.uncaught, false, "Proof-runner assertions remain blocking");
    }
    const results = reports.map((report) => classify(parseVerdict(JSON.parse(readFileSync(report, "utf8"))), policy, job,
      readFileSync(join(upstream, "e2e/tests/production-ops-database.spec.ts"), "utf8")));
    if (results.every((result) => result !== null)) {
      tracked = results.flatMap((result) => result ?? []);
      blocking = false;
    }
  } catch {
    console.error("CI flake evidence is incomplete or invalid; the failure remains blocking.");
  }
}
writeFileSync(join(output, `${id}.json`), JSON.stringify({
  job, exitCode: code, signal, interrupted, blocking, tracked,
  reports: reports.map((report) => relative(root, report)),
}, null, 2));
for (const entry of tracked) {
  console.log(`::warning title=Tracked flake ${entry.id}::${entry.title}. Owner: ${entry.owner}. Fix: carry ${entry.fix.carry}. Raw failure retained.`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Tracked flake \`${entry.id}\`: ${entry.title}. Owner: ${entry.owner}. Fix: carry ${entry.fix.carry}. Raw failure retained.\n`);
}
process.exitCode = blocking ? code || 1 : 0;
