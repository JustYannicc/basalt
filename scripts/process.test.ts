import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChildProcessFailure } from "./failure/child.ts";
import { run } from "./process.ts";

const node = process.execPath;
const module = fileURLToPath(new URL("./process.ts", import.meta.url));
const secret = "s3cr3t-value-0123456789";
const environment = { PATH: process.env.PATH, FIXTURE_API_TOKEN: secret };
// A caller that never returns is stopped before the suite's own limit, so it fails with its output.
const bounded = { encoding: "utf8", timeout: 50_000, killSignal: "SIGKILL" } as const;

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
  assert.match(error.message, /Authorization: \[redacted\]/);
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
      `import { run } from ${JSON.stringify(module)};
       run(process.execPath, ["-e", "for (let i = 0; i < ${lines}; i++) console.log('line ' + i); console.error('to stderr')"]);`,
    ],
    { ...bounded, maxBuffer: 64 * 1024 * 1024 },
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
  assert.equal(missing.message, "basalt-no-such-command could not start (ENOENT)");
  // A directory that does not exist is the command's failure to start, not this module's.
  const nowhere = failure(() => run("sh", ["-c", "true"], "/basalt-no-such-directory"));
  assert.equal(nowhere.message, "sh could not start (ENOENT)");

  const killed = failure(() => run(node, ["-e", "process.kill(process.pid, 'SIGKILL')"]));
  assert.equal(killed.report.signal, "SIGKILL");
  assert.match(killed.message, /failed with SIGKILL/);
});

test("a descendant that keeps the output open does not hold the caller", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-run-descendant-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "pid");
  run(node, [
    "-e",
    `const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit", detached: true });
     require("node:fs").writeFileSync(process.argv[1], String(child.pid));
     child.unref();
     console.log("parent done");`,
    pidFile,
  ]);
  const descendant = Number(readFileSync(pidFile, "utf8"));
  // Signal 0 only asks whether the process exists: it does, so `run()` did not wait for it.
  process.kill(descendant, 0);
  process.kill(descendant, "SIGKILL");
});

test("standard input reaches the command", () => {
  const child = spawnSync(
    node,
    [
      "--input-type=module",
      "-e",
      `import { run } from ${JSON.stringify(module)};
       run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"]);`,
    ],
    { ...bounded, input: "typed input\n" },
  );
  assert.equal(child.stdout, "typed input\n", child.stderr);
});

test("the caller's NODE_OPTIONS reach the command, and nothing of the plumbing does", () => {
  // A preload that does not exist would stop any Node process it is loaded into.
  const options = "--require=/basalt-no-such-preload.cjs";
  run(
    "sh",
    [
      "-c",
      `test "$NODE_OPTIONS" = "${options}" && test -z "$BASALT_RUN_NODE_OPTIONS" && test -z "$BASALT_RUN_REPORT"`,
    ],
    undefined,
    { PATH: process.env.PATH, NODE_OPTIONS: options },
  );
});

test("an interrupt sent to the whole group reaches the command once", async () => {
  // The command counts its interrupts, says when it is ready, and reports the count as it leaves.
  const command = `let count = 0;
    process.on("SIGINT", () => { if (++count === 1) setTimeout(() => { console.log("interrupts " + count); process.exit(0); }, 300); });
    console.log("ready"); setInterval(() => {}, 1000);`;
  // The caller leads a group of its own, so one signal reaches it, the process in between and the
  // command at once, the way a terminal's interrupt does.
  const caller = spawn(
    node,
    [
      "--input-type=module",
      "-e",
      `import { run } from ${JSON.stringify(module)};
       run(process.execPath, ["-e", ${JSON.stringify(command)}]);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const group = -caller.pid!;
  let output = "";
  let errors = "";
  caller.stderr.on("data", (chunk: Buffer) => {
    errors += chunk;
  });
  caller.stdout.on("data", (chunk: Buffer) => {
    const ready = output.includes("ready");
    output += chunk;
    if (!ready && output.includes("ready")) process.kill(group, "SIGINT");
  });
  // A group that never ends is stopped, so a broken `run()` fails here with what it printed.
  const deadline = setTimeout(() => process.kill(group, "SIGKILL"), 30_000);
  await new Promise((resolve) => caller.once("close", resolve));
  clearTimeout(deadline);

  assert.equal(output, "ready\ninterrupts 1\n", errors);
});

test("under Bun the command gets its last lines reported and only the caller's environment", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-run-bun-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  // Bun loads an `.env` from the directory it starts in, and the command's directory has one.
  writeFileSync(join(directory, ".env"), "PROBE_FROM_DOTENV=leaked\n");
  const command = 'echo "probe=${PROBE_FROM_DOTENV:-unset} in $(basename "$PWD")"; exit 4';
  const result = spawnSync(
    "bun",
    [
      "-e",
      `import { run } from ${JSON.stringify(module)};
       try { run("sh", ["-c", ${JSON.stringify(command)}], ${JSON.stringify(directory)}, { PATH: process.env.PATH }); }
       catch (error) { console.log(JSON.stringify(error.report)); }`,
    ],
    bounded,
  );
  assert.equal(result.status, 0, result.stderr);
  // The command's own output arrives first, live; the report is the last line.
  assert.deepEqual(JSON.parse(result.stdout.trimEnd().split("\n").at(-1)!), {
    command: "sh",
    exitCode: 4,
    signal: null,
    tail: `--- stdout\nprobe=unset in ${basename(directory)}`,
  });
});
