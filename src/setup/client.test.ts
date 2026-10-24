import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "../../brand.ts";

const run = promisify(execFile);
const client = fileURLToPath(new URL("./client.mjs", import.meta.url));
test("the runnable installer consumes a private payload, writes both clients and undoes without echoing credentials", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "installer-entry-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const payload = join(home, "payload.json");
  const credentials = { modelUrl: "http://127.0.0.1:8317", modelKey: "fixture-model-credential", toolsUrl: "http://127.0.0.1:8787/mcp", toolsToken: "fixture-tools-credential" };
  await writeFile(payload, JSON.stringify({ version: 1, brand, credentials }), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
  const installed = await run(process.execPath, [client, "--payload-file", payload], { cwd: home, env });
  assert.match(installed.stdout, /setup is done/);
  assert.doesNotMatch(installed.stdout + installed.stderr, /fixture-(model|tools)-credential/);
  const settings = JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, credentials.modelUrl);
  assert.match(await readFile(join(env.CODEX_HOME, "config.toml"), "utf8"), /requires_openai_auth = true/);
  const undone = await run(process.execPath, [client, "--undo"], { cwd: home, env });
  assert.match(undone.stdout, /Backups restored/);
  await assert.rejects(readFile(join(env.CODEX_HOME, "config.toml")), { code: "ENOENT" });
});
