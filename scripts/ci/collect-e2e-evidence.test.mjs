import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { collectE2eEvidence } from "./collect-e2e-evidence.mjs";
import { copyE2eEvidence } from "../e2e-evidence.ts";
import { finalizeE2e } from "../e2e-finalize.ts";

test("embedded assertion evidence retains only closed labels and safe integer counters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "assertion-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const report = join(source, "self-host/report/evidence/case");
  await mkdir(report, { recursive: true });
  const secret = "private-endpoint-sentinel";
  await writeFile(
    join(report, "assertion-diagnostics.json"),
    JSON.stringify([
      {
        operation: "Manage-only admins get no App tab or prewarm",
        phase: "embedded-manage-only-admin",
        assertion: "no-app-tab-or-frame",
        counters: { AppLinks: 1, iframes: 0, adminLocationReads: 2, [secret]: 4 },
        actual: secret,
        message: secret,
      },
      { operation: secret, phase: secret, assertion: secret, counters: { AppLinks: secret } },
    ]),
  );
  const output = join(root, "output");
  copyE2eEvidence(source, output);
  const text = await readFile(
    join(output, "self-host/report/evidence/case/assertion-diagnostics.json"),
    "utf8",
  );
  assert.ok(!text.includes(secret));
  assert.deepEqual(JSON.parse(text), {
    version: 1,
    truncated: false,
    records: [
      {
        stage: "assertion",
        outcome: "observed",
        phase: "embedded-manage-only-admin",
        kind: "assertion",
        operation: "Manage-only admins get no App tab or prewarm",
        assertion: "no-app-tab-or-frame",
        counters: { AppLinks: 1, iframes: 0, adminLocationReads: 2 },
      },
      { stage: "assertion", outcome: "observed", phase: "unknown", kind: "unknown" },
    ],
  });
});

test("finalized assertion evidence survives CI collection through the closed projector", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "assertion-finalize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, ".upstream/.local/e2e/run-one");
  const relative = "self-host/report/evidence/case/assertion-diagnostics.json";
  await mkdir(dirname(join(run, relative)), { recursive: true });
  await writeFile(join(run, ".basalt-run-owner.json"), JSON.stringify({ pid: process.pid }));
  const secret = "private-finalize-sentinel";
  const records = [
    { assertion: "no-app-tab-or-frame", counters: { AppLinks: 1, iframes: 0 } },
    { assertion: "no-app-prewarm", counters: { adminLocationReads: 2 } },
  ].map((record) => ({
    operation: "Manage-only admins get no App tab or prewarm",
    phase: "embedded-manage-only-admin",
    ...record,
    actual: secret,
  }));
  await writeFile(join(run, relative), JSON.stringify(records));
  finalizeE2e(root, run, "failed", {
    ci: true,
    retain: undefined,
    artifacts: join(root, "artifacts"),
  });
  await assert.rejects(readFile(join(run, relative)), { code: "ENOENT" });
  const exported = join(root, ".generated/e2e-evidence");
  const first = JSON.parse(await readFile(join(exported, "run-one", relative), "utf8"));
  // Even a modified export must go through the same closed projector again.
  first.private = secret;
  first.records[0].counters[secret] = 3;
  first.truncated = true;
  await writeFile(join(exported, "run-one", relative), JSON.stringify(first));
  const output = join(root, "ci-evidence");
  await collectE2eEvidence(exported, output, join(root, ".upstream/.local/e2e"));
  const text = await readFile(join(output, "run-one", relative), "utf8");
  assert.ok(!text.includes(secret));
  assert.deepEqual(JSON.parse(text), {
    version: 1,
    truncated: true,
    records: records.map(({ actual: _actual, ...record }) => ({
      stage: "assertion",
      outcome: "observed",
      phase: record.phase,
      kind: "assertion",
      operation: record.operation,
      assertion: record.assertion,
      counters: record.counters,
    })),
  });
});

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

test("retains nested development server stderr without its runtime state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ci-development-logs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, "original"),
    exported = join(root, "exported"),
    destination = join(root, "retained");
  const scenario = "run/self-host/scenarios/failed";
  const retained = [
    `${scenario}/development-a/server.log`,
    `${scenario}/development-a/development-b/server.log`,
  ];
  const excluded = [
    `${scenario}/development-a/environment.json`,
    `${scenario}/development-a/compiler-cache-host.log`,
    `${scenario}/development-a/screenshot.png`,
    `${scenario}/development-a/database/private.json`,
    `${scenario}/development-a/diagnostics/server.log`,
  ];
  for (const file of [...retained, ...excluded]) {
    await mkdir(dirname(join(original, file)), { recursive: true });
    await writeFile(join(original, file), file);
  }
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "server.log"), "not a fixture log");
  await symlink(outside, join(original, scenario, "development-linked"));
  await mkdir(join(original, scenario, "development-linked-log"));
  await symlink(
    join(outside, "server.log"),
    join(original, scenario, "development-linked-log/server.log"),
  );
  await mkdir(join(original, scenario, "development-pipe"));
  execFileSync("mkfifo", [join(original, scenario, "development-pipe/server.log")]);

  const summary = copyE2eEvidence(join(original, "run"), join(exported, "run"), { full: true });
  assert.equal(summary.files, retained.length);
  for (const file of retained) assert.equal(await readFile(join(exported, file), "utf8"), file);

  const fallback = `${scenario}/development-fallback/server.log`;
  await mkdir(dirname(join(original, fallback)), { recursive: true });
  await writeFile(join(original, fallback), "stderr from the original run");
  const merged = await collectE2eEvidence(exported, destination, original);
  assert.equal(merged.files, retained.length + 1);
  for (const file of retained) assert.equal(await readFile(join(destination, file), "utf8"), file);
  assert.equal(await readFile(join(destination, fallback), "utf8"), "stderr from the original run");
  assert.deepEqual((await readdir(join(destination, scenario))).sort(), [
    "development-a",
    "development-fallback",
  ]);
  assert.deepEqual((await readdir(join(destination, scenario, "development-a"))).sort(), [
    "development-b",
    "server.log",
  ]);
});
