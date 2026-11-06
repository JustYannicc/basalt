import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { finalizeE2e } from "../e2e-finalize.ts";

test("declared jobs upload reports retained after a forced failure prunes the original run", async (t) => {
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
    const uploadIndex = job.steps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const collectIndex = job.steps.findIndex((step) =>
      step.run?.includes("node scripts/ci/collect-e2e-evidence.mjs "),
    );
    assert.ok(collectIndex >= 0 && collectIndex < uploadIndex, `${name} collects before upload`);
    const upload = job.steps[uploadIndex];
    assert.equal(job.steps[collectIndex].if, "always()", name);
    assert.equal(upload.if, "always()", name);
    assert.equal(upload.with["include-hidden-files"], true, name);
    const directory = join(root, name);
    const run = join(directory, ".upstream/.local/e2e/forced-failure");
    const report = join(run, target, "report/diagnostics");
    await mkdir(report, { recursive: true });
    await writeFile(join(run, ".basalt-run-owner.json"), JSON.stringify({ pid: process.pid }));
    const results = JSON.stringify({ success: false, numFailedTests: 1, exitCode: failed.status });
    const graph = JSON.stringify({ synthetic: true, waiter: 1, blockers: [2] });
    await writeFile(join(report, "results.json"), results);
    await writeFile(join(report, "timeout-lock-graph.json"), graph);
    finalizeE2e(directory, run, "failed", {
      ci: true,
      retain: undefined,
      artifacts: join(directory, "artifacts"),
    });
    await assert.rejects(readFile(join(report, "results.json")), { code: "ENOENT" });
    const runnerTemp = join(directory, "runner-temp");
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
    const patterns = upload.with.path
      .split("\n")
      .filter(Boolean)
      .map((pattern) => pattern.replace("${{ runner.temp }}", runnerTemp));
    for (const [file, expected] of [
      ["results.json", results],
      ["timeout-lock-graph.json", graph],
    ]) {
      const path = join(output, "forced-failure", target, "report/diagnostics", file);
      assert.equal(await readFile(path, "utf8"), expected, name);
      assert.ok(
        patterns.some((pattern) => matchesGlob(path, pattern)),
        `${name} uploads ${file}`,
      );
    }
    if (process.env.BASALT_E2E_UPLOAD_PROOF_DIR) {
      await cp(output, join(process.env.BASALT_E2E_UPLOAD_PROOF_DIR, name), { recursive: true });
    }
  }
});
