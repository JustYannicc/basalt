import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { createPreviewProcessRunner } from "./preview-process.ts";

function runner(options: { outputLimit?: number; killGraceMs?: number } = {}) {
  return createPreviewProcessRunner({
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/isolated-preview-home", PREVIEW_SAFE: "yes" },
    ...options,
  });
}

test("preview subprocess receives only its supplied environment and captures output privately", async () => {
  const result = await runner().run(process.execPath, ["-e", `process.stdout.write(JSON.stringify({
    home: process.env.HOME, safe: process.env.PREVIEW_SAFE,
    openai: process.env.OPENAI_API_KEY === undefined, anthropic: process.env.ANTHROPIC_API_KEY === undefined,
    sdk: process.env.OPENAI_BASE_URL === undefined
  })); process.stderr.write("private diagnostic")`], tmpdir(), 5_000);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    home: "/isolated-preview-home", safe: "yes", openai: true, anthropic: true, sdk: true,
  });
  assert.equal(result.stderr, "private diagnostic");
  assert.equal(result.truncated, false);
});

test("preview subprocess capture stays within its configured output bound", async () => {
  const result = await runner({ outputLimit: 16 }).run(process.execPath, ["-e", `
    process.stdout.write("x".repeat(100)); process.stderr.write("y".repeat(100))`], tmpdir(), 5_000);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "x".repeat(16));
  assert.equal(result.stderr, "y".repeat(16));
  assert.equal(result.truncated, true);
});

test("preview subprocess timeout and explicit stop signal only its owned process group", async () => {
  const timed = await runner({ killGraceMs: 100 }).run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], tmpdir(), 75);
  assert.equal(timed.timedOut, true);
  assert.equal(timed.signal, "SIGTERM");

  const processRunner = runner({ killGraceMs: 100 });
  const active = processRunner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], tmpdir(), 5_000);
  await new Promise(resolve => setTimeout(resolve, 25));
  await processRunner.stop();
  const stopped = await active;
  assert.equal(stopped.timedOut, false);
  assert.ok(stopped.signal === "SIGTERM" || stopped.signal === "SIGKILL");
});
