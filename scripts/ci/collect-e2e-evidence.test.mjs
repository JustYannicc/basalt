import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
