import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");

test("restart authority is main-only, serialized with releases and unavailable to dependency preparation", async () => {
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/pool-runtime-recovery.yml", import.meta.url),
      "utf8",
    ),
  );
  const release = parse(
    await readFile(new URL("../.github/workflows/release-main.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "plan_json",
    "plan_sha256",
  ]);
  const job = workflow.jobs.recover;
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(job.environment.name, "production-release");
  assert.equal(workflow.concurrency.group, release.concurrency.group);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const steps = job.steps;
  const dry = steps.findIndex((s: { run?: string }) => s.run?.endsWith("entry.ts dry-run"));
  const apply = steps.findIndex((s: { run?: string }) => s.run?.endsWith("entry.ts apply"));
  assert.ok(dry >= 0 && apply > dry);
  assert.ok(
    steps
      .slice(dry + 1, apply)
      .some((s: { uses?: string }) => s.uses === "actions/upload-artifact@v4"),
  );
  for (let i = 0; i < steps.length; i++) {
    if (i !== apply) assert.ok(!JSON.stringify(steps[i]).includes("POOL_APP_SIGNING_KEY"));
  }
  assert.equal(steps[apply].env.POOL_APP_SIGNING_KEY, "${{ secrets.POOL_APP_SIGNING_KEY }}");
});

test("the executable refuses a non-main dispatch before opening any private binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-workflow-guard-"));
  try {
    const command = spawnSync(
      process.execPath,
      [new URL("./runtime-recovery/entry.ts", import.meta.url).pathname, "apply"],
      {
        encoding: "utf8",
        env: {
          GITHUB_REF: "refs/heads/feature",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          RECOVERY_OUTPUT_DIRECTORY: directory,
          POOL_APP_SIGNING_KEY: "private-signing-sentinel",
        },
      },
    );
    assert.equal(command.status, 1);
    assert.equal(
      JSON.parse(await readFile(join(directory, "report.json"), "utf8")).reason,
      "protected-main-dispatch-required",
    );
    assert.ok(!`${command.stdout}${command.stderr}`.includes("private-signing-sentinel"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic recovery is opt-in and its observation and preparation steps have no signing authority", async () => {
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/pool-runtime-automatic.yml", import.meta.url),
      "utf8",
    ),
  );
  const manual = parse(
    await readFile(
      new URL("../.github/workflows/pool-runtime-recovery.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.match(workflow.jobs.recover.if, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow.jobs.recover.if, /vars.POOL_AUTOMATIC_RECOVERY_PLAN != ''/);
  assert.match(workflow.jobs.recover.if, /vars.POOL_AUTOMATIC_RECOVERY_PLAN_SHA256 != ''/);
  assert.deepEqual(workflow.concurrency, manual.concurrency);
  assert.equal(workflow.jobs.recover.environment.name, "production-release");
  const steps = workflow.jobs.recover.steps;
  const apply = steps.findIndex((s: { run?: string }) =>
    s.run?.endsWith("automatic-entry.ts apply"),
  );
  assert.ok(apply > 0);
  assert.ok(
    steps.slice(0, apply).some((s: { uses?: string }) => s.uses === "actions/upload-artifact@v4"),
  );
  for (let index = 0; index < steps.length; index++) {
    if (index !== apply) assert.ok(!JSON.stringify(steps[index]).includes("POOL_APP_SIGNING_KEY"));
  }
  assert.equal(steps[apply].env.POOL_APP_SIGNING_KEY, "${{ secrets.POOL_APP_SIGNING_KEY }}");
});

test("the automatic executable refuses non-main schedules before opening a private binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "automatic-workflow-guard-"));
  try {
    const command = spawnSync(
      process.execPath,
      [new URL("./runtime-recovery/automatic-entry.ts", import.meta.url).pathname, "apply"],
      {
        encoding: "utf8",
        env: {
          GITHUB_REF: "refs/heads/feature",
          GITHUB_EVENT_NAME: "schedule",
          GITHUB_RUN_ATTEMPT: "1",
          RECOVERY_OUTPUT_DIRECTORY: directory,
          POOL_APP_SIGNING_KEY: "private-signing-sentinel",
        },
      },
    );
    assert.equal(command.status, 1);
    assert.equal(
      JSON.parse(await readFile(join(directory, "automatic-report.json"), "utf8")).reason,
      "protected-main-schedule-required",
    );
    assert.ok(!`${command.stdout}${command.stderr}`.includes("private-signing-sentinel"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
