import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { privateDirectory } from "../cli/private-files.ts";
import { ConnectionSupervisor } from "../desktop/supervisor.ts";

// The connection's private IPC is a Unix socket here; Windows uses a named pipe.
const skip = process.platform === "win32";

async function profile(context: TestContext) {
  const home = await privateDirectory(await mkdtemp(join(tmpdir(), "desktop-log-")));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("the supervisor keeps the connection's later warnings, redacted, in the profile folder", { skip }, async (context) => {
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
  assert.match(kept, /NATIVE_TUNNEL_CLIENT_FAILURE \{ phase: 'stream', event: 'close', closeCode: 1006/);
  assert.match(kept, /Connection process exited \(code 0, signal null\)\./);
  assert.doesNotMatch(kept, /private-query-key|private-bearer/);
});
