import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { validateDependencyReport } from "./ci-browser-packages.ts";
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

for (const updateFails of [false, true]) {
  test(`browser package identification ${updateFails ? "stops on an index refresh failure" : "refreshes missing indexes before the real dependency probe"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "browser-identify-"));
    try {
      const bin = join(root, "bin");
      const upstream = join(root, ".upstream");
      const receipt = join(root, "calls.jsonl");
      for (const directory of [
        bin,
        join(root, "scripts"),
        join(upstream, "node_modules/playwright"),
      ])
        mkdirSync(directory, { recursive: true });
      writeFileSync(join(root, "os-release"), "ID=ubuntu\nVERSION_ID=26.04\n");
      writeFileSync(join(upstream, "node_modules/playwright/package.json"), '{"version":"1.63.0"}');
      const source = readFileSync(new URL("./ci-browser-packages.ts", import.meta.url), "utf8");
      writeFileSync(
        join(root, "scripts/ci-browser-packages.ts"),
        source.replace('"/etc/os-release"', JSON.stringify(join(root, "os-release"))),
      );
      const command = `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = ${JSON.stringify(root)};
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ name, args }) + '\\n');
if (name === 'sudo') {
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (name === 'apt-get') {
  if (${updateFails}) process.exit(100);
  if (!args.includes('update')) process.exit(2);
  writeFileSync(join(root, 'indexes-ready'), 'yes');
} else if (name === 'bunx') {
  if (!existsSync(join(root, 'indexes-ready'))) {
    console.log("Failed to install browser dependencies\\nError: 'apt-get install -s' exited with code 100:");
    console.log('E: Unable to locate package fonts-unifont');
    process.exit(1);
  }
  console.log(${JSON.stringify(report.trimEnd())});
  process.exit(1);
} else process.exit(2);
`;
      for (const name of ["sudo", "apt-get", "bunx"])
        writeFileSync(join(bin, name), command, { mode: 0o755 });
      const action = parse(
        readFileSync(
          new URL("../.github/actions/setup-browser/action.yml", import.meta.url),
          "utf8",
        ),
      );
      const identify = action.runs.steps.find((step: { id?: string }) => step.id === "packages");
      const output = join(root, "output");
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", identify.run], {
        cwd: upstream,
        env: {
          ...process.env,
          PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
      const calls = readFileSync(receipt, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { name: string; args: string[] });
      if (updateFails) {
        assert.notEqual(result.status, 0);
        assert.ok(
          !calls.some((call) => call.name === "bunx"),
          "a failed refresh must not probe stale indexes",
        );
      } else {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.deepEqual(
          calls.map((call) => call.name),
          ["sudo", "apt-get", "bunx"],
        );
        assert.match(readFileSync(output, "utf8"), /^fingerprint=[a-f0-9]{64}\n$/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("the fast lane requires an actual browser installation", () => {
  const { jobs } = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const job = jobs["browser-install"];
  assert.ok(job, "the browser installer needs its own fast-lane job");
  assert.equal(job.if, undefined, "the browser check also runs in the PR fast lane");
  assert.equal(job["runs-on"], "ubuntu-latest");
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
