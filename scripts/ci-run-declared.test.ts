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
// Eleven files that pass on retry: more than a step's annotations can name one by one.
const burst = Array.from({ length: 11 }, (_, index) => "burst" + (index + 1));
const titles: Record<string, string> = {
  passes: "Passes",
  fails: "Fails",
  flaky: "Flaky",
  hangs: "Hangs",
  lingers: "Lingers",
  relapses: "Relapses",
  ...Object.fromEntries(burst.map((key, index) => [key, "Flaky burst " + (index + 1)])),
};
// What a failing attempt reports; the shard record must keep only its scrubbed form.
const failingTitle = "Signs in as owner@example.com at app.example.test for account 123456789";
const scrubbedTitle = "Signs in as [redacted] at [redacted] for account [redacted]";

// Stands in for `bun run e2e:<target>`: it records which file ran, then exports or abandons its run.
// "Flaky" titles fail only their first attempt in a checkout; "Relapses" fails it, then hangs.
const fakeSuite = `
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
const pattern = process.argv[process.argv.indexOf("--test-name") + 1];
const key = pattern.replace(/\\W/g, "");
const name = Date.now() + "-self-host-" + Math.random().toString(16).slice(2, 8);
const first = !existsSync("../" + key + ".ran");
if (first) writeFileSync("../" + key + ".ran", "");
const hangs = pattern.includes("Hangs") || (pattern.includes("Relapses") && !first);
const failing = pattern.includes("Fails") || (/Flaky|Relapses/.test(pattern) && first);
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
if (hangs) {
  process.on("SIGTERM", () => {});
  // Like the suite's servers: its own process group, found only through the process tree.
  child("hung-" + key, true);
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
const pair = (key: string) => ({
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
    const runs = ["fails", "flaky", "hangs", "lingers", "passes", "relapses"].map(pair);
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
    assert.equal(annotations.length, 6, annotations.join("\n"));
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
    // A retry that hangs is still a failed file, but not a second plain failure.
    assert.match(
      annotations[5]!,
      /^::error title=e2e retry::.*relapses\.spec\.ts failed, then timed out at its per-file deadline/,
    );
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
        ["relapses.spec.ts", "timed-out", ["failed", "timed-out"]],
      ],
    );
    for (const marker of ["hung-Hangs", "hung-Relapses", "lingering"])
      assert.equal(alive(Number(readFileSync(join(root, marker + ".pid"), "utf8"))), false, marker);
    for (const [index, run] of runs.entries()) {
      const directory = join(evidence, evidenceDirectory(run));
      const title = titles[run.file.replace(".spec.ts", "")];
      const attempts = results[index]!.attempts;
      // One run per attempt, each in its own directory; a pass on retry leaves the failure intact.
      for (const attempt of attempts) {
        const [report, ...others] = reports(join(directory, attemptDirectory(attempt.attempt)));
        assert.deepEqual(others, [], run.file);
        assert.equal(report.pattern, `^(?:${title})$`, run.file);
        if (attempt.outcome !== "timed-out")
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
      run_attempt: 1,
      files: [
        {
          group: "declared:self-host",
          file: "fails.spec.ts",
          attempts: 2,
          conclusion: "failed",
          retry_outcome: "failed",
          first_failure: [scrubbedTitle],
        },
        {
          group: "declared:self-host",
          file: "flaky.spec.ts",
          attempts: 2,
          conclusion: "passed",
          retry_outcome: "passed",
          first_failure: [scrubbedTitle],
        },
        {
          group: "declared:self-host",
          file: "relapses.spec.ts",
          attempts: 2,
          conclusion: "failed",
          retry_outcome: "timed-out",
          first_failure: [scrubbedTitle],
        },
      ],
    });
    assert.deepEqual(readdirSync(join(root, ".generated/e2e-evidence")), []);
    assert.deepEqual(readdirSync(join(root, ".upstream/.local/e2e")), ["earlier"]);
    const table = readFileSync(join(root, "summary.md"), "utf8");
    assert.equal(table.split("\n").filter((line) => line.endsWith("s |")).length, 6);
    assert.match(table, /\| fails\.spec\.ts \| declared:self-host \| failed twice \| 0m 0\ds \|/);
    assert.match(table, /\| flaky\.spec\.ts \| declared:self-host \| passed on retry \|/);
    assert.match(table, /\| hangs\.spec\.ts \| declared:self-host \| timed-out \|/);
    assert.match(table, /\| relapses\.spec\.ts \| declared:self-host \| failed, then timed out \|/);
    assert.match(
      table,
      /\nRetries: 1 passed on retry, 1 failed twice, 1 failed then timed out or cancelled\.\n$/,
    );
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
        GITHUB_RUN_ATTEMPT: "3",
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
    assert.equal(record.run_attempt, 3);
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

test("retries past a step's annotation limit collapse into one line but stay in the record and summary", () =>
  fixture(async (root) => {
    const evidence = join(root, "evidence");
    const lines: string[] = [];
    await runDeclaredShard(burst.map(pair), {
      root,
      evidence,
      deadlineMs: 3_000,
      graceMs: 1_000,
      log: (line) => lines.push(line),
      summary: join(root, "summary.md"),
    });
    const annotations = lines.filter((line) => /^::(?:error|warning)/.test(line));
    assert.equal(annotations.length, 10, annotations.join("\n"));
    assert.ok(annotations.slice(0, 9).every((line) => line.endsWith(" passed on retry")));
    assert.equal(
      annotations[9],
      "::warning title=e2e retry::…and 2 more retried files (see the job summary)",
    );
    assert.equal(json(join(evidence, "retries.json")).files.length, 11);
    const table = readFileSync(join(root, "summary.md"), "utf8");
    assert.equal(table.match(/\| passed on retry \|/g)?.length, 11);
  }));
