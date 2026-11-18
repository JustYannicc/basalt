import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { attemptDirectory, evidenceDirectory, runDeclaredShard } from "./ci/run-declared.ts";

const script = fileURLToPath(new URL("./ci/run-declared.ts", import.meta.url));
const titles = {
  passes: "Passes",
  fails: "Fails",
  flaky: "Flaky",
  hangs: "Hangs",
  lingers: "Lingers",
} as const;
// What a failing attempt reports; the shard record must keep only its scrubbed form.
const failingTitle = "Signs in as owner@example.com at app.example.test for account 123456789";
const scrubbedTitle = "Signs in as [redacted] at [redacted] for account [redacted]";

// Stands in for `bun run e2e:<target>`: it records which file ran, then exports or abandons its run.
// "Flaky" fails only its first attempt in a checkout.
const fakeSuite = `
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
const pattern = process.argv[process.argv.indexOf("--test-name") + 1];
const name = Date.now() + "-self-host-" + Math.random().toString(16).slice(2, 8);
const failing = pattern.includes("Fails") || (pattern.includes("Flaky") && !existsSync("../flaky.failed"));
if (pattern.includes("Flaky") && failing) writeFileSync("../flaky.failed", "");
const report = (root) => {
  mkdirSync(root + "/self-host/report/diagnostics", { recursive: true });
  const assertionResults = [
    { title: ${JSON.stringify(failingTitle)}, status: failing ? "failed" : "passed" },
    { title: "Unrelated", status: "passed" },
  ];
  const testResults = [{ name: "fixture.spec.ts", assertionResults }];
  writeFileSync(root + "/self-host/report/diagnostics/results.json", JSON.stringify({ pattern, testResults }));
};
const run = ".local/e2e/" + name;
report(run);
// The child ignores SIGTERM and says so only once its handler is installed.
const child = (marker, detached) => {
  const path = "../" + marker + ".pid";
  const source = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
  const process_ = spawn(process.execPath, ["-e", source, path], { stdio: "ignore", detached });
  while (!existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  return process_;
};
if (pattern.includes("Hangs")) {
  process.on("SIGTERM", () => {});
  // Like the suite's servers: its own process group, found only through the process tree.
  child("hung", true);
  setInterval(() => {}, 1000);
} else {
  report("../.generated/e2e-evidence/" + name);
  rmSync(run, { recursive: true });
  if (pattern.includes("Lingers")) child("lingering", false).unref();
  process.exitCode = failing ? 1 : 0;
}
`;

function fixture(run: (root: string) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "basalt-run-declared-"));
  const write = (path: string, value: unknown) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  write("scripts/ci/inherited-tests.json", { manualTargets: {} });
  write("scripts/ci/e2e-groups.json", {
    "declared:self-host": {
      job: "declared-self-host",
      target: "self-host",
      mode: "managed",
      matrix: true,
    },
  });
  for (const [key, title] of Object.entries(titles))
    write(`e2e/plans/${key}.spec.ts.json`, {
      scenarios: {
        [key]: {
          title,
          targets: {
            "self-host": { status: "scheduled" },
            local: { status: "not-applicable", reason: "Fixture" },
            cloud: { status: "not-applicable", reason: "Fixture" },
          },
        },
      },
      runs: { [key]: ["declared:self-host"] },
    });
  write(".upstream/package.json", { scripts: { "e2e:self-host": "node ../fake-suite.mjs" } });
  write("fake-suite.mjs", fakeSuite);
  // A developer's earlier run is neither collected nor removed.
  write(".upstream/.local/e2e/earlier/self-host/report/diagnostics/results.json", "{}");
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pair = (key: keyof typeof titles) => ({
  group: "declared:self-host",
  file: `${key}.spec.ts`,
});
const reports = (directory: string) =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      JSON.parse(
        readFileSync(
          join(directory, entry.name, "self-host/report/diagnostics/results.json"),
          "utf8",
        ),
      ),
    );
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("a shard runs every file after a failure or a hang, retries only plain failures once and keeps each attempt's evidence apart", () =>
  fixture(async (root) => {
    const evidence = join(root, "evidence");
    const runs = [pair("fails"), pair("flaky"), pair("hangs"), pair("lingers"), pair("passes")];
    const lines: string[] = [];
    const results = await runDeclaredShard(runs, {
      root,
      evidence,
      deadlineMs: 3_000,
      graceMs: 1_000,
      log: (line) => lines.push(line),
      summary: join(root, "summary.md"),
      job: "declared-self-host",
      shard: "declared-self-host-1",
    });
    const annotations = lines.filter((line) => /^::(?:error|warning)/.test(line));
    assert.equal(annotations.length, 5, annotations.join("\n"));
    assert.match(
      annotations[0]!,
      /^::error title=e2e retry::declared:self-host fails\.spec\.ts failed twice \(exit 1\)/,
    );
    assert.equal(
      annotations[1],
      "::warning title=e2e retry::declared:self-host flaky.spec.ts passed on retry",
    );
    assert.match(
      annotations[2]!,
      /^::error title=Declared E2E timed-out::.*hangs\.spec\.ts timed-out at its per-file deadline/,
    );
    // The lingering process ignores SIGTERM, so it is asked first and killed after the grace.
    assert.match(annotations[3]!, /^::warning::Stopping processes a declared file left running/);
    assert.match(annotations[4]!, /^::warning::Killing processes a declared file left running/);
    assert.deepEqual(
      results.map(({ file, outcome, attempts }) => [
        file,
        outcome,
        attempts.map((attempt) => attempt.outcome),
      ]),
      [
        ["fails.spec.ts", "failed", ["failed", "failed"]],
        ["flaky.spec.ts", "passed", ["failed", "passed"]],
        // A hang is never retried, and neither is a file that passed.
        ["hangs.spec.ts", "timed-out", ["timed-out"]],
        ["lingers.spec.ts", "passed", ["passed"]],
        ["passes.spec.ts", "passed", ["passed"]],
      ],
    );
    for (const marker of ["hung", "lingering"])
      assert.equal(alive(Number(readFileSync(join(root, marker + ".pid"), "utf8"))), false, marker);
    for (const [index, run] of runs.entries()) {
      const directory = join(evidence, evidenceDirectory(run));
      const title = titles[run.file.replace(".spec.ts", "") as keyof typeof titles];
      const attempts = results[index]!.attempts;
      // One run per attempt, each in its own directory; a pass on retry leaves the failure intact.
      for (const attempt of attempts) {
        const [report, ...others] = reports(join(directory, attemptDirectory(attempt.attempt)));
        assert.deepEqual(others, [], run.file);
        assert.equal(report.pattern, `^(?:${title})$`, run.file);
        if (run.file !== "hangs.spec.ts")
          assert.equal(
            report.testResults[0].assertionResults[0].status,
            attempt.outcome,
            `${run.file} attempt ${attempt.attempt}`,
          );
      }
      assert.equal(existsSync(join(directory, attemptDirectory(attempts.length + 1))), false);
      const record = json(join(directory, "declared-run.json"));
      assert.equal(record.file, run.file);
      assert.equal(record.outcome, results[index]!.outcome);
      assert.deepEqual(
        record.attempts.map((attempt: { outcome: string }) => attempt.outcome),
        attempts.map((attempt) => attempt.outcome),
      );
      assert.deepEqual(record.first_failure, attempts.length > 1 ? [scrubbedTitle] : [], run.file);
    }
    assert.deepEqual(json(join(evidence, "retries.json")), {
      format: "basalt-e2e-retries-v1",
      job: "declared-self-host",
      shard: "declared-self-host-1",
      files: [
        {
          group: "declared:self-host",
          file: "fails.spec.ts",
          attempts: 2,
          conclusion: "failed",
          first_failure: [scrubbedTitle],
        },
        {
          group: "declared:self-host",
          file: "flaky.spec.ts",
          attempts: 2,
          conclusion: "passed",
          first_failure: [scrubbedTitle],
        },
      ],
    });
    assert.deepEqual(readdirSync(join(root, ".generated/e2e-evidence")), []);
    assert.deepEqual(readdirSync(join(root, ".upstream/.local/e2e")), ["earlier"]);
    const table = readFileSync(join(root, "summary.md"), "utf8");
    assert.equal(table.split("\n").filter((line) => line.endsWith("s |")).length, 5);
    assert.match(table, /\| fails\.spec\.ts \| declared:self-host \| failed twice \| 0m 0\ds \|/);
    assert.match(table, /\| flaky\.spec\.ts \| declared:self-host \| passed on retry \|/);
    assert.match(table, /\| hangs\.spec\.ts \| declared:self-host \| timed-out \|/);
    assert.match(table, /\nRetries: 1 passed on retry, 1 failed twice\.\n$/);
  }));

test("the shard command fails, annotates and summarizes when any file fails", () =>
  fixture((root) => {
    const step = join(root, "summary.md");
    const result = spawnSync(
      "bun",
      [script, "declared:self-host fails.spec.ts declared:self-host passes.spec.ts"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: step, RUNNER_TEMP: join(root, "runner") },
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stdout,
      /::error title=e2e retry::declared:self-host fails\.spec\.ts failed twice \(exit 1\)/,
    );
    assert.doesNotMatch(result.stdout, /::error[^\n]*passes\.spec\.ts/);
    assert.match(
      readFileSync(step, "utf8"),
      /\| passes\.spec\.ts \| declared:self-host \| passed \|/,
    );
    assert.ok(
      existsSync(
        join(
          root,
          "runner/basalt-e2e-evidence/passes.spec.ts-declared-self-host/declared-run.json",
        ),
      ),
    );
    const passing = spawnSync("bun", [script, "declared:self-host passes.spec.ts"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "", RUNNER_TEMP: join(root, "again") },
    });
    assert.equal(passing.status, 0, passing.stderr);
    // A pass on retry passes the job, but never silently.
    const retried = spawnSync("bun", [script, "declared:self-host flaky.spec.ts"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: "",
        GITHUB_JOB: "declared-self-host",
        BASALT_E2E_SHARD: "declared-self-host-2",
        RUNNER_TEMP: join(root, "retried"),
      },
    });
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(
      retried.stdout,
      /^::warning title=e2e retry::declared:self-host flaky\.spec\.ts passed on retry$/m,
    );
    assert.doesNotMatch(retried.stdout, /::error/);
    const record = json(join(root, "retried/basalt-e2e-evidence/retries.json"));
    assert.equal(record.job, "declared-self-host");
    assert.equal(record.shard, "declared-self-host-2");
    assert.deepEqual(
      record.files.map((file: { file: string; conclusion: string }) => [
        file.file,
        file.conclusion,
      ]),
      [["flaky.spec.ts", "passed"]],
    );
    for (const runs of [
      "declared:self-host missing.spec.ts",
      "declared:self-host",
      "declared:other passes.spec.ts",
    ]) {
      const invalid = spawnSync("bun", [script, runs], { cwd: root, encoding: "utf8" });
      assert.notEqual(invalid.status, 0, runs);
    }
  }));
