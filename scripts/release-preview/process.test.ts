import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    let sequence = 0;
    const fail = (step: string) =>
      assert.rejects(
        privateOperation(
          {
            label: "fixture",
            command: process.execPath,
            args: ["-e", `const fs = require('node:fs');${step};process.exit(1);`],
            directory,
            environment: { PATH: process.env.PATH },
            logPath: join(directory, `${++sequence}.log`),
            timeoutMs: 5_000,
          },
          publish,
        ),
        { message: "Preview fixture failed" },
      );
    const report = (text: string) =>
      `fs.appendFileSync(process.env.PREVIEW_FAILURE_REPORT, ${JSON.stringify(text)})`;

    // A value the step never held, a preview host, a link and a forged workflow command.
    await fail(
      `console.error('private-fixture-output');${report(
        [
          "## Preview deploy step failed",
          "  why: refused fixture-leaf-access-token",
          "    deployed app.pr-41.Preview-Zone.invalid",
          "::error::forged",
          "  link https://pr-41.preview-zone.invalid/x",
          "",
        ].join("\n"),
      )}`,
    );
    const published = [
      "## Preview deploy step failed",
      "  why: refused [redacted]",
      "    deployed [host]",
      ": :error::forged",
      "  link [url]",
      "",
    ].join("\n");
    assert.deepEqual(printed, [published]);
    assert.equal(await readFile(summary, "utf8"), published);
    assert.match(await readFile(join(directory, "1.log"), "utf8"), /private-fixture-output/);

    // No report, a report swapped for a link to another file, and one past its bound.
    printed.length = 0;
    await fail("");
    await writeFile(join(directory, "other"), "fixture-other-file-content\n");
    await fail(
      `fs.rmSync(process.env.PREVIEW_FAILURE_REPORT);fs.symlinkSync(${JSON.stringify(join(directory, "other"))}, process.env.PREVIEW_FAILURE_REPORT)`,
    );
    assert.equal(printed.length, 0);
    await fail(
      report(
        `## Preview deploy step failed\n\n\`\`\`text\n${"line of a long report\n".repeat(4_000)}\`\`\`\n`,
      ),
    );
    assert.equal(printed.length, 1);
    assert.ok(printed[0]!.length <= 64 * 1024 + 16);
    // The cut closes the summary's code block it fell inside.
    assert.match(printed[0]!, /line of a long report\n\[cut\]\n```\n$/u);
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
