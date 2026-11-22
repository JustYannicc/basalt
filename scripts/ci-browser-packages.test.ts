import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { packageCacheKey, validateDependencyReport } from "./ci-browser-packages.ts";
import { conditionalJobs, fastJobs, gateErrors } from "./ci/gate.ts";
import { heavyJobs } from "./ci/areas.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");

const report = "Missing system dependencies (2):\n  fonts-liberation\n  libnss3\n";

for (const [name, stdout] of [
  ["header-only", "Missing system dependencies (2):\n"],
  [
    "changed body format",
    "Missing system dependencies (2):\n  packages=[fonts-liberation,libnss3]\n",
  ],
  ["count mismatch", report.replace("(2)", "(3)")],
  ["extra package", report + "  xvfb\n"],
  ["duplicate package", report.replace("libnss3", "fonts-liberation")],
  ["unexpected line between packages", report.replace("  libnss3", "apt failed\n  libnss3")],
  ["unexpected prefix", "apt failed\n" + report],
  ["unexpected suffix", report + "apt failed\n"],
  ["empty package set", "Missing system dependencies (0):\n"],
]) {
  test(`Playwright dependency report rejects ${name}`, () => {
    assert.throws(() => validateDependencyReport(1, stdout, ""), /Unexpected Playwright/);
  });
}

test("Playwright 1.63 missing-dependencies report passes", () => {
  assert.doesNotThrow(() => validateDependencyReport(1, report, ""));
});

test("a valid report cannot hide stderr failures or an unexpected exit status", () => {
  assert.throws(() => validateDependencyReport(1, report, "apt failed\n"), /Unexpected Playwright/);
  assert.throws(() => validateDependencyReport(2, report, ""), /Unexpected Playwright/);
  assert.throws(() => validateDependencyReport(null, report, ""), /Unexpected Playwright/);
});

test("installed dependencies require the exact successful Playwright report", () => {
  assert.doesNotThrow(() =>
    validateDependencyReport(0, "All system dependencies are installed.\n", ""),
  );
  assert.throws(() => validateDependencyReport(0, report, ""), /Unexpected Playwright/);
});

const timeout = ["timeout", "gtimeout"].flatMap((command) =>
  spawnSync(command, ["--version"]).status === 0
    ? [spawnSync("which", [command], { encoding: "utf8" }).stdout.trim()]
    : [],
)[0];

type Refresh = "complete" | "ok" | "fail" | "hang-once" | "hang" | "security-down" | "archive-down";

// Runs the action's real identify step against shims; the refresh bound is two seconds here.
function runSteps(ids: string[], refresh: Refresh) {
  assert.ok(timeout, "GNU timeout is required for the refresh bound proof");
  const root = mkdtempSync(join(tmpdir(), "browser-identify-"));
  const bin = join(root, "bin");
  const upstream = join(root, ".upstream");
  const action = join(root, ".github/actions/setup-browser");
  const receipt = join(root, "calls.jsonl");
  const apt = join(root, "etc/apt");
  for (const directory of [
    bin,
    action,
    join(root, "scripts"),
    join(root, "tmp"),
    join(apt, "apt.conf.d"),
    join(apt, "sources.list.d"),
    join(upstream, "node_modules/.bin"),
    join(upstream, "node_modules/playwright"),
  ])
    mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "os-release"), "ID=ubuntu\nVERSION_ID=26.04\n");
  // The hosted image ships a Microsoft source next to Ubuntu's; we install nothing from it.
  writeFileSync(
    join(apt, "sources.list.d/ubuntu.sources"),
    "Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu\nSuites: resolute\n",
  );
  writeFileSync(
    join(apt, "sources.list.d/microsoft-prod.list"),
    "deb [arch=amd64] https://packages.microsoft.com/ubuntu/26.04/prod resolute main\n",
  );
  writeFileSync(join(upstream, "node_modules/playwright/package.json"), '{"version":"1.63.0"}');
  const source = readFileSync(new URL("./ci-browser-packages.ts", import.meta.url), "utf8");
  writeFileSync(
    join(root, "scripts/ci-browser-packages.ts"),
    source.replace('"/etc/os-release"', JSON.stringify(join(root, "os-release"))),
  );
  writeFileSync(
    join(action, "refresh-index.sh"),
    readFileSync(
      new URL("../.github/actions/setup-browser/refresh-index.sh", import.meta.url),
      "utf8",
    ),
  );
  const command = `#!${process.execPath}
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = ${JSON.stringify(root)};
const refresh = ${JSON.stringify(refresh)};
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ name, args }) + '\\n');
const complete = refresh === 'complete';
const report = () => {
  if (complete) {
    console.log('All system dependencies are installed.');
    process.exit(0);
  }
  if (!existsSync(join(root, 'indexes-ready'))) {
    console.log("Failed to install browser dependencies\\nError: 'apt-get install -s' exited with code 100:");
    console.log('E: Unable to locate package fonts-unifont');
    process.exit(1);
  }
  console.log(${JSON.stringify(report.trimEnd())});
  process.exit(1);
};
if (name === 'sudo') {
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit' });
  process.exit(result.status ?? (result.signal ? 124 : 1));
}
if (name === 'apt-get') {
  if (!args.includes('update') || !args.includes('APT::Update::Error-Mode=any')) process.exit(2);
  // Resolve sources as apt does: Dir::Etc::sourceparts from apt.conf.d, else sources.list.d.
  const apt = ${JSON.stringify(apt)};
  let parts = join(apt, 'sources.list.d');
  for (const file of readdirSync(join(apt, 'apt.conf.d'))) {
    const match = /Dir::Etc::sourceparts "([^"]+)";/.exec(readFileSync(join(apt, 'apt.conf.d', file), 'utf8'));
    if (match) parts = match[1];
  }
  const sources = readdirSync(parts).map((file) => readFileSync(join(parts, file), 'utf8')).join('');
  if (!sources.includes('archive.ubuntu.com/ubuntu')) process.exit(2);
  if (sources.includes('packages.microsoft.com')) {
    console.error('E: Failed to fetch https://packages.microsoft.com/ubuntu/26.04/prod/dists/resolute/InRelease  429  Too Many Requests');
    process.exit(100);
  }
  const tries = readFileSync(${JSON.stringify(receipt)}, 'utf8').split('\\n').filter((line) => line.includes('"name":"apt-get"')).length;
  // A crawling download that never finishes on its own, as a slow mirror does.
  // Real apt output, captured with the security host, then the archive too, pointed at an unroutable
  // address.
  const failed = (url) => console.error('E: Failed to fetch ' + url + '  Connection failed [IP: 10.255.255.1 80]');
  if (refresh === 'hang' || (refresh === 'hang-once' && tries === 1)) setInterval(() => {}, 1000);
  else if (refresh === 'fail') process.exit(100);
  else if (refresh === 'security-down' || refresh === 'archive-down') {
    if (refresh === 'archive-down') {
      failed('mirror+file:/etc/apt/apt-mirrors.txt/dists/resolute/InRelease');
      failed('http://archive.ubuntu.com/ubuntu/dists/resolute-updates/InRelease');
    }
    else writeFileSync(join(root, 'indexes-ready'), 'yes');
    failed('http://security.ubuntu.com/ubuntu/dists/resolute-security/InRelease');
    console.error('E: Some index files failed to download. They have been ignored, or old ones used instead.');
    process.exit(100);
  }
  else writeFileSync(join(root, 'indexes-ready'), 'yes');
} else if (name === 'bunx' || name === 'playwright') {
  if (!args.includes('--dry-run')) process.exit(2);
  report();
} else process.exit(2);
`;
  for (const name of ["sudo", "apt-get", "bunx"])
    writeFileSync(join(bin, name), command, { mode: 0o755 });
  writeFileSync(join(upstream, "node_modules/.bin/playwright"), command, { mode: 0o755 });
  // macOS names GNU timeout gtimeout; the production runner names it timeout.
  writeFileSync(join(bin, "timeout"), `#!/bin/sh\nexec ${timeout} "$@"\n`, { mode: 0o755 });
  const workflow = parse(
    readFileSync(new URL("../.github/actions/setup-browser/action.yml", import.meta.url), "utf8"),
  );
  const output = join(root, "output");
  const started = Date.now();
  let result = spawnSync("true", { encoding: "utf8" });
  for (const id of ids) {
    const step = workflow.runs.steps.find(
      (candidate: { id?: string; name?: string }) => candidate.id === id || candidate.name === id,
    );
    // Redirect only system paths so the real step runs without changing the host.
    const run = step.run.replaceAll("/etc/apt", apt);
    result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", run], {
      cwd: upstream,
      env: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
        GITHUB_ACTION_PATH: action,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: join(root, "tmp"),
        BROWSER_APT_REFRESH_SECONDS: "2",
        BROWSER_APT_REFRESH_PAUSE_SECONDS: "0",
        ImageOS: "ubuntu26",
        ImageVersion: "20261111.196.1",
      },
      encoding: "utf8",
    });
    if (result.status !== 0) break;
  }
  const calls = readFileSync(receipt, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { name: string; args: string[] });
  let written = "";
  try {
    written = readFileSync(output, "utf8");
  } catch {
    // No output is written when the step fails before the probe.
  }
  rmSync(root, { recursive: true, force: true });
  return { result, calls, output: written, seconds: (Date.now() - started) / 1000 };
}

const named = (calls: { name: string }[], name: string) =>
  calls.filter((call) => call.name === name).length;

const refreshStep = "Refresh the Ubuntu indexes for the missing packages";

for (const refresh of ["complete", "ok"] as const)
  test(`identifying the packages makes no apt request when they are ${refresh === "complete" ? "installed" : "missing"}`, () => {
    const { result, calls, output } = runSteps(["packages"], refresh);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(named(calls, "apt-get"), 0);
    assert.match(
      output,
      new RegExp(
        `^complete=${refresh === "complete"}\nkey=playwright-debs-v2-[a-f0-9]{32}-[a-f0-9]{16}\nprefix=playwright-debs-v2-[a-f0-9]{32}-\n$`,
      ),
    );
  });

test("missing packages refresh only the Ubuntu archives before the real dependency probe", () => {
  const { result, calls } = runSteps(["packages", refreshStep], "ok");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(
    calls.map((call) => call.name),
    // The offline identification first, then one bounded refresh and the real probe.
    ["sudo", "bunx", "sudo", "apt-get", "bunx"],
  );
});

test("a refresh that fails twice stops before probing stale indexes", () => {
  const { result, calls } = runSteps(["packages", refreshStep], "fail");
  assert.notEqual(result.status, 0);
  assert.equal(named(calls, "apt-get"), 2);
  // Only the offline identification probed; a failed refresh must not probe stale indexes.
  assert.equal(named(calls, "bunx"), 1);
});

test("a crawling refresh is cut at its bound and retried once", () => {
  const once = runSteps(["packages", refreshStep], "hang-once");
  assert.equal(once.result.status, 0, once.result.stdout + once.result.stderr);
  assert.equal(named(once.calls, "apt-get"), 2);
  assert.match(once.result.stdout, /retrying once/);
  const always = runSteps(["packages", refreshStep], "hang");
  assert.notEqual(always.result.status, 0);
  assert.equal(named(always.calls, "apt-get"), 2);
  // Two two-second bounds plus their kill grace, never the job's own deadline.
  assert.ok(always.seconds < 20, `the bounded refresh took ${always.seconds}s`);
});

test("a security index that can't be fetched keeps the image's copy, and nothing else does", () => {
  const security = runSteps(["packages", refreshStep], "security-down");
  assert.equal(security.result.status, 0, security.result.stdout + security.result.stderr);
  assert.equal(named(security.calls, "apt-get"), 1);
  assert.match(security.result.stdout, /::warning::Ubuntu's security index couldn't be fetched/);
  assert.deepEqual(
    security.calls.map((call) => call.name),
    ["sudo", "bunx", "sudo", "apt-get", "bunx"],
  );
  // A release pocket failing alongside it still fails after one retry, before the probe.
  const archive = runSteps(["packages", refreshStep], "archive-down");
  assert.notEqual(archive.result.status, 0);
  assert.equal(named(archive.calls, "apt-get"), 2);
  assert.equal(named(archive.calls, "bunx"), 1);
});

test("the deb cache key follows the image, and its prefix survives an image update", () => {
  const key = packageCacheKey(
    "ID=ubuntu\n",
    '{"version":"1.63.0"}',
    "x64",
    "ubuntu26",
    "20261111.1",
  );
  assert.deepEqual(
    packageCacheKey("ID=ubuntu\n", '{"version":"1.63.0"}', "x64", "ubuntu26", "20261111.1"),
    key,
  );
  const update = packageCacheKey(
    "ID=ubuntu\n",
    '{"version":"1.63.0"}',
    "x64",
    "ubuntu26",
    "20261118.1",
  );
  assert.equal(update.prefix, key.prefix);
  assert.notEqual(update.key, key.key);
  assert.ok(update.key.startsWith(update.prefix));
  for (const changed of [
    packageCacheKey(
      "ID=ubuntu\nVERSION_ID=26.10\n",
      '{"version":"1.63.0"}',
      "x64",
      "ubuntu26",
      "20261111.1",
    ),
    packageCacheKey("ID=ubuntu\n", '{"version":"1.64.0"}', "x64", "ubuntu26", "20261111.1"),
    packageCacheKey("ID=ubuntu\n", '{"version":"1.63.0"}', "x64", "ubuntu24", "20261111.1"),
    packageCacheKey("ID=ubuntu\n", '{"version":"1.63.0"}', "arm64", "ubuntu26", "20261111.1"),
  ])
    assert.notEqual(changed.prefix, key.prefix);
});

test("the action reaches the archive only after the offline paths fail", () => {
  const steps: { id?: string; name?: string; if?: string; uses?: string }[] = parse(
    readFileSync(new URL("../.github/actions/setup-browser/action.yml", import.meta.url), "utf8"),
  ).runs.steps;
  const step = (name: string) =>
    steps.find((candidate) => candidate.id === name || candidate.name === name);
  const online = "steps.packages.outputs.complete != 'true' && steps.offline.outcome != 'success'";
  assert.equal(step(refreshStep)?.if, online);
  assert.equal(step("Install system dependencies with bounded mirror downloads")?.if, online);
  assert.equal(
    step("offline")?.if,
    "steps.packages.outputs.complete != 'true' && steps.debs.outputs.cache-matched-key != ''",
  );
  assert.doesNotMatch(JSON.stringify(step("packages")), /apt-get|refresh-index/);
});

// A routable job's runs-on is the box router's expression; its hosted fallback is the image it
// runs on whenever the box doesn't take it.
const hostedImage = (runsOn: string) => /\|\| '([^']+)' \}\}$/.exec(runsOn)?.[1] ?? runsOn;

test("the fast lane requires an actual browser installation", () => {
  const { jobs } = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const job = jobs["browser-install"];
  assert.ok(job, "the browser installer needs its own fast-lane job");
  assert.equal(job.if, undefined, "the browser check also runs in the PR fast lane");
  assert.equal(hostedImage(job["runs-on"]), "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 10);
  assert.ok(
    job.steps.some(
      (step: { uses?: string; with?: Record<string, string> }) =>
        step.uses === "./.github/actions/setup-browser" &&
        step.with?.["prepare-upstream"] === "true",
    ),
  );
  assert.ok(fastJobs.includes("browser-install"));
  assert.ok(jobs.check.needs.includes("browser-install"));
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...conditionalJobs].map((name) => [
      name,
      { result: fastJobs.includes(name) ? "success" : "skipped" },
    ]),
  );
  assert.deepEqual(gateErrors(needs, [], [], false), []);
  for (const result of ["failure", "skipped", "cancelled"])
    assert.ok(
      gateErrors({ ...needs, "browser-install": { result } }, [], [], false).some((error) =>
        error.startsWith("browser-install:"),
      ),
    );
});

test("main warms the browser package cache that Check restores", () => {
  const read = (name: string) =>
    parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
  const ci = read("ci.yml");
  const warm = read("ci-cache-warm.yml");
  const job = warm.jobs["browser-packages"];
  // A cache saved on main is the one every branch and pull request can restore.
  assert.deepEqual(warm.on.push.branches, ["main"]);
  assert.ok(warm.on.schedule.length > 0);
  for (const path of [
    ".github/actions/setup-browser/**",
    "scripts/ci-browser-packages.ts",
    "upstream.json",
  ])
    assert.ok(warm.on.push.paths.includes(path), path);
  // The same image and pinned runtime as Check's browser jobs, so the key matches.
  assert.equal(job["runs-on"], hostedImage(ci.jobs["browser-install"]["runs-on"]));
  const uses = (steps: { uses?: string; with?: Record<string, string> }[], action: string) =>
    steps.find((step) => step.uses === action)?.with;
  assert.deepEqual(uses(job.steps, "./.github/actions/setup-browser"), {
    "prepare-upstream": "true",
  });
  assert.equal(
    uses(job.steps, "./.github/actions/setup-bun")?.["bun-version"],
    ci.env.E2E_BUN_VERSION,
  );
  assert.equal(
    uses(job.steps, "./.github/actions/setup-node")?.["node-version"],
    uses(ci.jobs["browser-install"].steps, "./.github/actions/setup-node")?.["node-version"],
  );
});
