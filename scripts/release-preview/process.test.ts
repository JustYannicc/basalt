import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { privateOperation } from "./process.ts";

test("provider errors stay private and a timed-out owned process is stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-operation-"));
  try {
    const logPath = join(directory, "private.log");
    await assert.rejects(
      privateOperation({
        label: "fixture",
        command: process.execPath,
        args: ["-e", "console.error('private-fixture-output');process.exit(1)"],
        directory,
        environment: { PATH: process.env.PATH },
        logPath,
        timeoutMs: 5_000,
      }),
      { message: "Preview fixture failed" },
    );
    assert.match(await readFile(logPath, "utf8"), /private-fixture-output/);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    await assert.rejects(
      privateOperation({
        label: "fixture",
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        directory,
        environment: { PATH: process.env.PATH },
        logPath: join(directory, "timeout.log"),
        timeoutMs: 40,
      }),
      { message: "Preview fixture timed out" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed step publishes only its own report, cleaned of every credential the runner holds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-operation-"));
  try {
    const summary = join(directory, "summary.md");
    const printed: string[] = [];
    const publish = {
      environment: {
        GITHUB_STEP_SUMMARY: summary,
        PREVIEW_CLAUDE_AUTH_JSON: '{"type":"claude","access_token":"fixture-leaf-access-token"}',
        TEST_STAGE_DOMAIN: "preview-zone.invalid",
      },
      write: (text: string) => void printed.push(text),
    };
    // The step reports with a value it never held, which only this process can remove.
    const step = [
      "const { appendFileSync } = require('node:fs');",
      "console.error('private-fixture-output');",
      "appendFileSync(process.env.PREVIEW_FAILURE_REPORT, '## Preview lifecycle step failed\\n  why: refused fixture-leaf-access-token\\n    deployed pr-41.preview-zone.invalid\\n');",
      "process.exit(1);",
    ].join("");
    await assert.rejects(
      privateOperation(
        {
          label: "fixture",
          command: process.execPath,
          args: ["-e", step],
          directory,
          environment: { PATH: process.env.PATH },
          logPath: join(directory, "step.log"),
          timeoutMs: 5_000,
        },
        publish,
      ),
      { message: "Preview fixture failed" },
    );
    assert.deepEqual(printed, [
      "## Preview lifecycle step failed\n  why: refused [redacted]\n    deployed pr-41.[redacted]\n",
    ]);
    assert.equal(await readFile(summary, "utf8"), printed[0]);
    assert.match(await readFile(join(directory, "step.log"), "utf8"), /private-fixture-output/);

    // A step that writes no report publishes nothing beyond the fixed label.
    printed.length = 0;
    await assert.rejects(
      privateOperation(
        {
          label: "fixture",
          command: process.execPath,
          args: ["-e", "process.exit(1)"],
          directory,
          environment: { PATH: process.env.PATH },
          logPath: join(directory, "silent.log"),
          timeoutMs: 5_000,
        },
        publish,
      ),
      { message: "Preview fixture failed" },
    );
    assert.deepEqual(printed, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelled work never starts a provider process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-operation-"));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      privateOperation({
        label: "fixture",
        command: "unreachable-fixture-command",
        args: [],
        directory,
        environment: {},
        logPath: join(directory, "cancel.log"),
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
      { message: "Preview fixture cancelled" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
