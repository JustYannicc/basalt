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
    await assert.rejects(privateOperation({ label: "fixture", command: process.execPath,
      args: ["-e", "console.error('private-fixture-output');process.exit(1)"],
      directory, environment: { PATH: process.env.PATH }, logPath, timeoutMs: 5_000 }),
    { message: "Preview fixture failed" });
    assert.match(await readFile(logPath, "utf8"), /private-fixture-output/);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    await assert.rejects(privateOperation({ label: "fixture", command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"], directory, environment: { PATH: process.env.PATH },
      logPath: join(directory, "timeout.log"), timeoutMs: 40 }), { message: "Preview fixture timed out" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancelled work never starts a provider process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preview-operation-"));
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(privateOperation({ label: "fixture", command: "unreachable-fixture-command",
      args: [], directory, environment: {}, logPath: join(directory, "cancel.log"),
      timeoutMs: 5_000, signal: controller.signal }), { message: "Preview fixture cancelled" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
