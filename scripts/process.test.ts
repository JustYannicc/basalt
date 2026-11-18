import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChildProcessFailure } from "./failure/child.ts";
import { run } from "./process.ts";

const node = process.execPath;
const secret = "s3cr3t-value-0123456789";
const environment = { PATH: process.env.PATH, FIXTURE_API_TOKEN: secret };

function failure(action: () => void): ChildProcessFailure {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof ChildProcessFailure, String(error));
    return error;
  }
  return assert.fail("The command was expected to fail");
}

test("a failed command's error carries the end of its output with credentials removed", () => {
  const script = `
    console.log("building stage one");
    console.error("Error: upload refused by https://api.example.com/client/v4/accounts/abc?token=1");
    console.error("  Authorization: Bearer ${secret}");
    console.error("  token ${secret} was sent to deploy@example.com at 203.0.113.7:443");
    process.exit(3);`;
  const error = failure(() => run(node, ["-e", script], undefined, environment));

  assert.equal(error.report.exitCode, 3);
  assert.match(error.message, /^node failed with exit 3\n/);
  assert.match(error.message, /--- stdout\nbuilding stage one/);
  assert.match(error.message, /--- stderr\nError: upload refused by \[url\]/);
  assert.match(error.message, /Authorization: Bearer \[redacted\]/);
  for (const forbidden of [secret, "api.example.com", "deploy@example.com", "203.0.113.7"])
    assert.ok(!error.message.includes(forbidden), forbidden);
  // Only the program is named: its arguments are not repeated.
  assert.ok(!error.message.includes('building stage one");'));
});

test("the command's output still reaches the caller's own output, complete and as written", () => {
  const lines = 20_000;
  const child = spawnSync(
    node,
    [
      "--input-type=module",
      "-e",
      `import { run } from ${JSON.stringify(fileURLToPath(new URL("./process.ts", import.meta.url)))};
       run(process.execPath, ["-e", "for (let i = 0; i < ${lines}; i++) console.log('line ' + i); console.error('to stderr')"]);`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(child.status, 0, child.stderr);
  const written = child.stdout.trimEnd().split("\n");
  assert.equal(written.length, lines);
  assert.equal(written[0], "line 0");
  assert.equal(written.at(-1), `line ${lines - 1}`);
  assert.equal(child.stderr, "to stderr\n");
});

test("a command that cannot start, or dies from a signal, says so", () => {
  const missing = failure(() => run("basalt-no-such-command", []));
  assert.equal(missing.report.stopped, "not-started");
  assert.match(missing.message, /^basalt-no-such-command could not start/);

  const killed = failure(() => run(node, ["-e", "process.kill(process.pid, 'SIGKILL')"]));
  assert.equal(killed.report.signal, "SIGKILL");
  assert.match(killed.message, /failed with SIGKILL/);
});

test("a descendant that keeps the output open does not hold the caller", () => {
  const started = performance.now();
  run(node, [
    "-e",
    `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "inherit", detached: true }).unref();
     console.log("parent done");`,
  ]);
  assert.ok(performance.now() - started < 10_000);
});

test("standard input reaches the command", () => {
  const child = spawnSync(
    node,
    [
      "--input-type=module",
      "-e",
      `import { run } from ${JSON.stringify(fileURLToPath(new URL("./process.ts", import.meta.url)))};
       run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"]);`,
    ],
    { encoding: "utf8", input: "typed input\n" },
  );
  assert.equal(child.stdout, "typed input\n");
});
