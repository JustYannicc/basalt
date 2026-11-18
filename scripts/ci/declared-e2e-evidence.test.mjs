import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { finalizeE2e } from "../e2e-finalize.ts";
import { collectNewE2eEvidence, runNames } from "./collect-e2e-evidence.mjs";
import { evidenceDirectory } from "./run-declared.ts";

test("declared shards upload each file's forced-failure reports apart, plus an interrupted run", async (t) => {
  const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const root = await mkdtemp(join(tmpdir(), "declared-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const failed = spawnSync(process.execPath, [
    "-e",
    "require('node:assert/strict').fail('forced evidence retention failure')",
  ]);
  assert.equal(failed.status, 1);
  const collector = fileURLToPath(new URL("./collect-e2e-evidence.mjs", import.meta.url));
  for (const target of ["self-host", "local", "cloud"]) {
    const name = `declared-${target}`;
    const job = workflow.jobs[name];
    const index = (predicate) => job.steps.findIndex(predicate);
    const runIndex = index((step) => step.run?.startsWith("bun scripts/ci/run-declared.ts "));
    const collectIndex = index((step) =>
      step.run?.includes("node scripts/ci/collect-e2e-evidence.mjs "),
    );
    const uploadIndex = index((step) => step.uses?.startsWith("actions/upload-artifact@"));
    assert.ok(runIndex >= 0 && runIndex < collectIndex, `${name} runs before the fallback`);
    assert.ok(collectIndex < uploadIndex, `${name} collects before upload`);
    const upload = job.steps[uploadIndex];
    assert.equal(job.steps[collectIndex].if, "always()", name);
    assert.equal(upload.if, "always()", name);
    const directory = join(root, name);
    const runnerTemp = join(directory, "runner-temp");
    const roots = [
      join(directory, ".generated/e2e-evidence"),
      join(directory, ".upstream/.local/e2e"),
    ];
    const patterns = upload.with.path
      .split("\n")
      .filter(Boolean)
      .map((pattern) => pattern.replace("${{ runner.temp }}", runnerTemp));
    const uploaded = (path) => patterns.some((pattern) => matchesGlob(path, pattern));
    const start = async (run) => {
      const report = join(directory, ".upstream/.local/e2e", run, target, "report/diagnostics");
      await mkdir(report, { recursive: true });
      await writeFile(
        join(directory, ".upstream/.local/e2e", run, ".basalt-run-owner.json"),
        JSON.stringify({ pid: process.pid }),
      );
      const files = [
        ["results.json", JSON.stringify({ success: false, run, exitCode: failed.status })],
        ["timeout-lock-graph.json", JSON.stringify({ synthetic: true, run })],
      ];
      for (const [file, content] of files) await writeFile(join(report, file), content);
      return files;
    };
    // Two files in one checkout, one after the other, as run-declared runs them.
    const files = ["first.spec.ts", "second.spec.ts"];
    for (const file of files) {
      const before = await runNames(roots);
      const run = `forced-failure-${file}`;
      const expected = await start(run);
      finalizeE2e(directory, join(directory, ".upstream/.local/e2e", run), "failed", {
        ci: true,
        retain: undefined,
        artifacts: join(directory, "artifacts"),
      });
      await assert.rejects(
        readFile(
          join(directory, ".upstream/.local/e2e", run, target, "report/diagnostics/results.json"),
        ),
        { code: "ENOENT" },
      );
      const destination = join(
        runnerTemp,
        "basalt-e2e-evidence",
        evidenceDirectory({ group: `declared:${target}`, file }),
      );
      await collectNewE2eEvidence(roots, before, destination);
      await writeFile(join(destination, "declared-run.json"), JSON.stringify({ file }));
      assert.ok(
        uploaded(join(destination, "declared-run.json")),
        `${name} uploads the file record`,
      );
      assert.deepEqual(await readdir(destination), ["declared-run.json", run].sort(), file);
      for (const [evidence, content] of expected) {
        const path = join(destination, run, target, "report/diagnostics", evidence);
        assert.equal(await readFile(path, "utf8"), content, `${name} ${file}`);
        assert.ok(uploaded(path), `${name} uploads ${evidence}`);
      }
    }
    // A file the job's deadline interrupts never finalizes; the fallback step keeps its run alone.
    const interrupted = await start("interrupted-run");
    const command = job.steps[collectIndex].run
      .split("\n")
      .find((line) => line.includes("node scripts/ci/collect-e2e-evidence.mjs "));
    const args = command
      .trim()
      .split(/\s+/)
      .slice(2)
      .map((argument) => argument.replace(/^"|"$/g, "").replace("$RUNNER_TEMP", runnerTemp));
    execFileSync(process.execPath, [collector, ...args], { cwd: directory, stdio: "pipe" });
    const output = resolve(directory, args[1]);
    assert.deepEqual(await readdir(output), ["interrupted-run"], name);
    for (const [evidence, content] of interrupted) {
      const path = join(output, "interrupted-run", target, "report/diagnostics", evidence);
      assert.equal(await readFile(path, "utf8"), content, name);
      assert.ok(uploaded(path), `${name} uploads interrupted ${evidence}`);
    }
    if (process.env.BASALT_E2E_UPLOAD_PROOF_DIR) {
      await cp(
        join(runnerTemp, "basalt-e2e-evidence"),
        join(process.env.BASALT_E2E_UPLOAD_PROOF_DIR, name),
        {
          recursive: true,
        },
      );
    }
  }
});

test("renewal proof uploads public evidence without fixture sessions or raw reports", async () => {
  const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const upload = workflow.jobs["oauth-account-regressions"].steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  const patterns = upload.with.path.split("\n").filter(Boolean);
  const base = ".generated/oauth-renewal-recovery/ci/";
  const included = (file) => patterns.some((pattern) => matchesGlob(base + file, pattern));
  for (const file of [
    "report.json",
    "outcomes.json",
    "invalid-grant-health.json",
    "invalid-request-details-390.png",
  ])
    assert.equal(included(file), true, file);
  for (const file of [
    "test-accounts/owner.json",
    "test-accounts/admin.json",
    "test-accounts/member.json",
    "report/evidence/session/requests.json",
    "server.log",
  ])
    assert.equal(included(file), false, file);
});
