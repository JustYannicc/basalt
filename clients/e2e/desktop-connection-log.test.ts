import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { privateDirectory } from "../cli/private-files.ts";
import { ConnectionLog } from "../desktop/connection-log.ts";
import { ConnectionSupervisor } from "../desktop/supervisor.ts";

// The connection's private IPC is a Unix socket here; Windows uses a named pipe.
const skip = process.platform === "win32";

async function profile(context: TestContext) {
  const home = await privateDirectory(await mkdtemp(join(tmpdir(), "desktop-log-")));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test(
  "the supervisor keeps the connection's later warnings, redacted, in the profile folder",
  { skip },
  async (context) => {
    const home = await profile(context);
    const entry = join(home, "connection-fixture.mjs");
    // Like the real connection: ready first, then a tunnel failure while it serves.
    await writeFile(
      entry,
      `process.stderr.write("Connection ready at http://127.0.0.1:4242.\\n");
process.once("SIGTERM", () =>
  process.stderr.write(
    "NATIVE_TUNNEL_CLIENT_FAILURE { phase: 'stream', event: 'close', closeCode: 1006, status: null }\\n" +
      "retry https://pool.example/v1/models?key=private-query-key Authorization: Bearer private-bearer-0123456789\\n",
    () => process.exit(0),
  ),
);
setInterval(() => {}, 60_000);
`,
    );
    const supervisor = new ConnectionSupervisor(home, entry, process.execPath);
    await supervisor.start();
    await supervisor.stop();
    const path = join(home, "connection.log");
    const kept = await readFile(path, "utf8");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const lines = kept.trimEnd().split("\n");
    for (const line of lines) assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \S/);
    assert.match(kept, /Connection ready at http:\/\/127\.0\.0\.1:4242\./);
    assert.match(
      kept,
      /NATIVE_TUNNEL_CLIENT_FAILURE \{ phase: 'stream', event: 'close', closeCode: 1006/,
    );
    assert.match(kept, /Connection process exited \(code 0, signal null\)\./);
    assert.doesNotMatch(kept, /private-query-key|private-bearer/);
  },
);

test("the connection log rotates to one previous file and stays bounded", async (context) => {
  const home = await profile(context);
  const path = join(home, "connection.log");
  const log = new ConnectionLog(path, 400);
  for (let index = 0; index < 60; index++) log.output(`warning ${index} ${"x".repeat(40)}\n`);
  await log.flushed();
  assert.ok((await stat(path)).size <= 400);
  assert.ok((await stat(`${path}.1`)).size <= 400);
  await assert.rejects(stat(`${path}.2`), { code: "ENOENT" });
  assert.match(await readFile(path, "utf8"), /warning 59 x+\n$/);
});

test("a line split across reads is kept whole and an endless line is cut", async (context) => {
  const home = await profile(context);
  const path = join(home, "connection.log");
  const log = new ConnectionLog(path);
  log.output("NATIVE_TUNNEL_");
  log.output("CLIENT_FAILURE { phase: 'headers' }\npartial");
  log.output(` ${"y".repeat(5_000)}`);
  await log.flushed();
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, / NATIVE_TUNNEL_CLIENT_FAILURE \{ phase: 'headers' \}$/);
  assert.match(lines[1]!, / partial y+$/);
  assert.equal(lines[1]!.length, 25 + 1024);
});
