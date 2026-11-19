import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, openSync, watch } from "node:fs";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { privateDirectory } from "../cli/private-files.ts";
import { ConnectionLog } from "../desktop/connection-log.ts";
import { ConnectionSupervisor } from "../desktop/supervisor.ts";
import { fixture } from "./native-client-fixture.ts";
import { command, main } from "./support.ts";

// The connection's private IPC is a Unix socket here; Windows uses a named pipe.
const skip = process.platform === "win32";
const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \S/u;

async function profile(context: TestContext) {
  const home = await privateDirectory(await mkdtemp(join(tmpdir(), "desktop-log-")));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** A stand-in connection: ready, then `onStop` written to stderr when it is stopped. */
async function connection(home: string, onStop = "Connection stopping.\n") {
  const entry = join(home, "connection-fixture.mjs");
  // The handler comes first: stop() can signal as soon as the ready line arrives.
  await writeFile(
    entry,
    `process.once("SIGTERM", () => process.stderr.write(${JSON.stringify(onStop)}, () => process.exit(0)));
process.stderr.write("Connection ready at http://127.0.0.1:4242.\\n");
setInterval(() => {}, 60_000);
`,
  );
  return entry;
}

/** Resolves with the file once it holds `pattern`; the test's own timeout bounds the wait. */
function written(path: string, pattern: RegExp) {
  return new Promise<string>((resolve, reject) => {
    const watcher = watch(dirname(path));
    const check = () =>
      readFile(path, "utf8").then(
        (text) => {
          if (!pattern.test(text)) return;
          watcher.close();
          resolve(text);
        },
        () => undefined,
      );
    watcher.on("change", check);
    watcher.on("error", reject);
    void check();
  });
}

test(
  "the real connection's tunnel failure reaches the log while the connection runs",
  // Headless file credential storage is a Linux choice; CI's client job runs on Linux.
  { skip: process.platform !== "linux", timeout: 30_000 },
  async () => {
    const native = await fixture();
    const supervisor = new ConnectionSupervisor(native.home, main, process.execPath);
    try {
      await native.login();
      await command(["agent", "add", "both", "models", "tools"], native.home);
      await supervisor.start();
      const path = join(native.home, "connection.log");
      native.remote.dropTool(true);
      const interrupted = await fetch(`${await supervisor.origin()}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await native.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      });
      assert.equal(interrupted.status, 502);
      assert.match(await interrupted.text(), /outcome may be unknown/u);
      // Read before stop: the incident case is reading the log while the app still runs.
      const running = await written(
        path,
        /NATIVE_TUNNEL_CLIENT_FAILURE \{ phase: '(?:handshake|headers|stream)', event: '(?:close|error)'/u,
      );
      assert.match(running, /Connection ready at http:\/\/127\.0\.0\.1:\d+\./u);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      for (const line of running.trimEnd().split("\n")) assert.match(line, stamp);
      await supervisor.stop();
      assert.match(
        await readFile(path, "utf8"),
        /Connection process exited \(code 0, signal null\)\.\n$/u,
      );
    } finally {
      await supervisor.stop();
      await native.close();
    }
  },
);

test("the supervisor redacts what the connection writes as it stops", { skip }, async (context) => {
  const home = await profile(context);
  const entry = await connection(
    home,
    "retry https://pool.example/v1/models?key=private-query-key Authorization: Bearer private-bearer-0123456789\n",
  );
  const supervisor = new ConnectionSupervisor(home, entry, process.execPath);
  await supervisor.start();
  await supervisor.stop();
  const kept = await readFile(join(home, "connection.log"), "utf8");
  for (const line of kept.trimEnd().split("\n")) assert.match(line, stamp);
  assert.match(kept, / retry https:\/\/pool\.example\/v1\/models Authorization: \[redacted\]\n/u);
  assert.match(kept, /Connection process exited \(code 0, signal null\)\./u);
  assert.doesNotMatch(kept, /private-query-key|private-bearer/u);
});

test("a stalled log write can't hold stop past its bound", { skip }, async (context) => {
  const home = await profile(context);
  const path = join(home, "connection.log");
  // A pipe nobody reads: opening it to write waits, like a filesystem that stopped answering.
  execFileSync("mkfifo", [path]);
  const supervisor = new ConnectionSupervisor(home, await connection(home), process.execPath);
  await supervisor.start();
  const held = new AbortController();
  const outcome = await Promise.race([
    supervisor.stop().then(() => "stopped" as const),
    delay(4_000, "held" as const, { signal: held.signal }).catch(() => "held" as const),
  ]);
  held.abort();
  // Then read the pipe so the stalled writes finish. Opening it read-write never waits, and the
  // reader stays open until the test ends so no later write waits again.
  const reader = new Socket({ fd: openSync(path, constants.O_RDWR), readable: true, writable: false });
  context.after(() => reader.destroy());
  reader.setEncoding("utf8");
  const received = await new Promise<string>((resolve) => {
    let text = "";
    reader.on("data", (chunk: string) => {
      text += chunk;
      if (text.includes("Connection process exited")) resolve(text);
    });
  });
  assert.equal(outcome, "stopped", "stop() waited on the stalled log for over 4 seconds");
  assert.match(received, /Connection ready at http:\/\/127\.0\.0\.1:4242\./u);
});

test("the connection log rotates to one previous file and stays bounded", async (context) => {
  const home = await profile(context);
  const path = join(home, "connection.log");
  const log = new ConnectionLog(path, 400);
  for (let index = 0; index < 60; index++) log.output(`warning ${index} ${"x".repeat(40)}\n`);
  // One read can carry many lines: the bound holds per line, not per read.
  log.output(Array.from({ length: 60 }, (_, index) => `burst ${index}\n`).join(""));
  await log.flushed();
  assert.ok((await stat(path)).size <= 400);
  assert.ok((await stat(`${path}.1`)).size <= 400);
  await assert.rejects(stat(`${path}.2`), { code: "ENOENT" });
  assert.match(await readFile(path, "utf8"), /burst 59\n$/u);
});

test("a long line without spaces is cut before redaction", async (context) => {
  const home = await profile(context);
  const path = join(home, "connection.log");
  const log = new ConnectionLog(path);
  // Redaction is quadratic on unbroken runs: 65,536 characters took about 5 s, 1,024 about 2 ms.
  const line = `retry https://pool.example/v1/models?key=private-query-key next ${"Zx9Qw7Lm3Rt5Yb1N".repeat(4096)}\n`;
  const started = performance.now();
  log.output(line);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `keeping one 65,536-character line took ${Math.round(elapsed)} ms`);
  await log.flushed();
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  assert.deepEqual(
    lines.map((kept) => kept.slice(25)),
    ["retry https://pool.example/v1/models next [cut]"],
  );
});

test("no part of a token reaches the log when a cut or a read boundary falls inside it", async (context) => {
  const home = await profile(context);
  // Redacted as [token] when whole; a shorter piece matches no pattern. Nothing else in these
  // lines, or in what the log adds after the timestamp, has a capital letter or a digit above 1.
  const token = "ZX9QW7LM3RT5YB2NC8VD2PK6HS4JF7GA";
  const lines = [
    `retry next ${token} tail`,
    // Redacting the long query would move a read boundary inside the kept 1,024 characters.
    `retry https://pool.example/v1/models?${"q=1&".repeat(300)} next ${token} tail`,
    // The 1,024-character cut falls inside the token.
    `${"word ".repeat(200)}${token} tail`,
    `${"word ".repeat(818)}${token} tail`,
    `retry https://pool.example/v1/models?${"q=1&".repeat(1200)} next ${token} tail`,
  ];
  for (const [index, line] of lines.entries()) {
    const start = line.indexOf(token);
    for (let offset = 0; offset <= token.length; offset++) {
      const path = join(home, `split-${index}-${offset}.log`);
      const log = new ConnectionLog(path);
      log.output(line.slice(0, start + offset));
      log.output(`${line.slice(start + offset)}\n`);
      await log.flushed();
      const kept = (await readFile(path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((entry) => entry.slice(25))
        .join("\n");
      assert.doesNotMatch(kept, /[A-Z2-9]/u, `line ${index}, read split at ${offset}: ${kept}`);
      // Dropping the whole line would pass the check above.
      assert.match(kept, /^(?:retry|word) /u);
    }
  }
});

test("a line split across reads is kept whole and an endless line is cut once", async (context) => {
  const home = await profile(context);
  const path = join(home, "connection.log");
  const log = new ConnectionLog(path);
  log.output("NATIVE_TUNNEL_");
  log.output("CLIENT_FAILURE { phase: 'headers' }\npartial");
  log.output(` ${"y".repeat(5_000)}`);
  log.output("z".repeat(3_000));
  log.output(" rest of the endless line\nnext warning\n");
  await log.flushed();
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  assert.deepEqual(
    lines.map((line) => line.slice(25)),
    ["NATIVE_TUNNEL_CLIENT_FAILURE { phase: 'headers' }", "partial [cut]", "next warning"],
  );
});

test("an unfinished last line is kept before the exit note", async (context) => {
  const home = await profile(context);
  const path = join(home, "connection.log");
  const log = new ConnectionLog(path);
  log.output("Connection lost before its newline");
  log.end("Connection process exited (code 1, signal null).");
  await log.flushed();
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  assert.deepEqual(
    lines.map((line) => line.slice(25)),
    ["Connection lost before its newline", "Connection process exited (code 1, signal null)."],
  );
});

test("the log is never written through a symlink", { skip }, async (context) => {
  const home = await profile(context);
  const target = join(home, "elsewhere.txt");
  await writeFile(target, "");
  await symlink(target, join(home, "connection.log"));
  const log = new ConnectionLog(join(home, "connection.log"));
  log.note("NATIVE_TUNNEL_CLIENT_FAILURE {}");
  await log.flushed();
  assert.equal(await readFile(target, "utf8"), "");
});
