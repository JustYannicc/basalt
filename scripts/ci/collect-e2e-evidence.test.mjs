import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { collectE2eEvidence } from "./collect-e2e-evidence.mjs";

test("retains reports and scenario logs without traversing runtime links or special files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ci-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "runs"),
    destination = join(root, "evidence");
  const retained = [
    "run/self-host/report/diagnostics/results.json",
    "run/self-host/report/evidence/case/screenshot.png",
    "run/self-host/report/lifecycle/case.json",
    "run/self-host/scenarios/failed/server.log",
    "run/self-host/cloud.log",
    "another/local/report/evidence/case/trace.json",
    "another/local/server.log",
  ];
  for (const file of [...retained, "run/self-host/scenarios/failed/database/private.json"]) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await writeFile(join(source, file), file);
  }
  const scenario = join(source, "run/self-host/scenarios/failed");
  await symlink(source, join(scenario, "node_modules"));
  await symlink(source, join(source, "run/self-host/report/runtime-link"));
  await symlink(
    join(scenario, "database/private.json"),
    join(source, "run/self-host/report/private.json"),
  );
  await symlink(scenario, join(source, "run/self-host/scenarios/linked"));
  execFileSync("mkfifo", [join(source, "run/self-host/report/pipe")]);
  const summary = await collectE2eEvidence(source, destination);
  assert.deepEqual(summary, {
    files: retained.length,
    bytes: retained.reduce((n, file) => n + Buffer.byteLength(file), 0),
  });
  for (const file of retained) assert.equal(await readFile(join(destination, file), "utf8"), file);
  assert.deepEqual((await readdir(join(destination, "run/self-host/report"))).sort(), [
    "diagnostics",
    "evidence",
    "lifecycle",
  ]);
  assert.deepEqual(await readdir(join(destination, "run/self-host/scenarios/failed")), [
    "server.log",
  ]);
});

test("setup failure with no run directory leaves a zero-file summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-evidence-empty-"));
  try {
    assert.deepEqual(await collectE2eEvidence(join(root, "missing"), join(root, "evidence")), {
      files: 0,
      bytes: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every E2E workflow upload retains original reports when the normal export is blocked", async (t) => {
  const { createRequire } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync } = await import("node:fs");
  const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const root = await mkdtemp(join(tmpdir(), "ci-evidence-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const collector = fileURLToPath(new URL("./collect-e2e-evidence.mjs", import.meta.url));
  let jobs = 0;
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const uploads = job.steps.filter(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact@") &&
        /(?:\.generated\/(?:e2e-evidence|ci-e2e-evidence|ci-evidence\/)|basalt-e2e-evidence)/.test(
          step.with?.path ?? "",
        ),
    );
    if (uploads.length === 0) continue;
    jobs++;
    const directory = join(root, name);
    const source = join(directory, ".upstream/.local/e2e/failed/self-host");
    await mkdir(join(source, "report/diagnostics"), { recursive: true });
    await mkdir(join(directory, ".generated"));
    await writeFile(join(directory, ".generated/e2e-evidence"), "export is blocked");
    await writeFile(join(source, "server.log"), "failed-cleanup-log");
    await writeFile(join(source, "report/diagnostics/results.json"), "failed-raw-report");
    await symlink(directory, join(source, "report/runtime-link"));
    const command = job.steps
      .flatMap((step) => (step.run ?? "").split("\n"))
      .find((line) => line.includes("node scripts/ci/collect-e2e-evidence.mjs "));
    assert.ok(command, `${name} must collect original-run fallback before uploading`);
    const runnerTemp = join(directory, "runner-temp");
    const args = command
      .trim()
      .split(/\s+/)
      .slice(2)
      .map((argument) => argument.replace(/^"|"$/g, "").replace("$RUNNER_TEMP", runnerTemp));
    await chmod(join(directory, ".generated"), 0o500);
    try {
      execFileSync(process.execPath, [collector, ...args], { cwd: directory, stdio: "pipe" });
    } finally {
      await chmod(join(directory, ".generated"), 0o700);
    }
    const output = resolve(directory, args[1], "failed/self-host");
    assert.equal(await readFile(join(output, "server.log"), "utf8"), "failed-cleanup-log", name);
    assert.equal(
      await readFile(join(output, "report/diagnostics/results.json"), "utf8"),
      "failed-raw-report",
      name,
    );
    assert.equal((await readdir(join(output, "report"))).includes("runtime-link"), false, name);
  }
  assert.ok(jobs > 0);
});

test("fallback fills missing Cloud logs while keeping the completed exported report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ci-evidence-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, "exported"),
    original = join(root, "original"),
    destination = join(root, "retained");
  for (const source of [primary, original])
    await mkdir(join(source, "run/cloud/report/diagnostics"), { recursive: true });
  await writeFile(join(primary, "run/cloud/report/diagnostics/results.json"), "completed-export");
  await writeFile(join(original, "run/cloud/report/diagnostics/results.json"), "original-report");
  await writeFile(join(original, "run/cloud/cloud.log"), "original-cloud-log");
  const summary = await collectE2eEvidence(primary, destination, original);
  assert.equal(summary.files, 2);
  assert.equal(
    await readFile(join(destination, "run/cloud/report/diagnostics/results.json"), "utf8"),
    "completed-export",
  );
  assert.equal(
    await readFile(join(destination, "run/cloud/cloud.log"), "utf8"),
    "original-cloud-log",
  );
});
