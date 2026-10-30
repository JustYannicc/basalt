import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { configure, configPaths } from "./files.mjs";
import { decode } from "./config.mjs";
import { brand } from "../../brand.ts";

const credentials = { modelUrl: "http://127.0.0.1:8317", modelKey: "test-model-key", toolsUrl: "http://127.0.0.1:8787/mcp", toolsToken: "test-tools-token" };
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "computer-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
  return { home, env, brand, credentials };
}
test("clean setup, rerun and undo restore file absence", async (t) => {
  const options = await fixture(t);
  await configure(options);
  await configure(options);
  const paths = configPaths(options.home, options.env);
  const claude = JSON.parse(await readFile(paths[0].path, "utf8"));
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, credentials.modelKey);
  const codex = decode(await readFile(paths[2].path, "utf8"), "toml");
  assert.equal(codex.model_providers.signalbox.requires_openai_auth, true);
  assert.equal(codex.model_providers.signalbox.http_headers["X-Api-Key"], credentials.modelKey);
  assert.equal((await stat(paths[2].path)).mode & 0o777, 0o600);
  await configure({ ...options, undo: true });
  for (const file of paths) await assert.rejects(readFile(file.path), { code: "ENOENT" });
});
test("another proxy, providers, servers and CRLF restore byte for byte after rerun and rename", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  const originals = [
    '{\r\n "env": {"ANTHROPIC_BASE_URL":"https://other.invalid", "CUSTOM":"kept"}, "permissions":{"allow":["Read"]}, "model":"own-model"\r\n}\r\n',
    '{"mcpServers":{"other":{"command":"other"},"signalbox":{"command":"old-unmarked"}},"onboarding":true}\n',
    '# personal config\r\nmodel_provider = "other"\r\nmodel = "own-model"\r\n[model_providers.other]\r\nname="Other"\r\nbase_url="https://other.invalid"\r\n[mcp_servers.other]\r\ncommand="other"\r\n',
  ];
  for (const [i, file] of paths.entries()) { await mkdir(dirname(file.path), { recursive: true }); await writeFile(file.path, originals[i]); }
  await configure(options);
  await configure({ ...options, brand: { ...brand, name: "Renamed", mcpServerName: "renamed", setup: { ...brand.setup, marker: "Renamed managed computer setup" } } });
  const codex = decode(await readFile(paths[2].path, "utf8"), "toml");
  assert.equal(codex.model_provider, "renamed");
  assert.ok(codex.model_providers.other);
  assert.ok(codex.mcp_servers.other);
  assert.equal(codex.model_providers.signalbox, undefined);
  await configure({ ...options, undo: true });
  for (const [i, file] of paths.entries()) assert.deepEqual(await readFile(file.path), Buffer.from(originals[i]));
});
test("undo preserves later unrelated edits and later replacements of owned values", async (t) => {
  const options = await fixture(t);
  await configure(options);
  const path = configPaths(options.home, options.env)[0].path;
  const value = JSON.parse(await readFile(path, "utf8"));
  value.permissions = { allow: ["Read"] };
  value.env.ANTHROPIC_BASE_URL = "https://later.invalid";
  await writeFile(path, JSON.stringify(value));
  await configure({ ...options, undo: true });
  const undone = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(undone.permissions, value.permissions);
  assert.equal(undone.env.ANTHROPIC_BASE_URL, "https://later.invalid");
  assert.equal(undone.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(undone[brand.setup.id], undefined);
});
test("malformed existing config fails before writing any config", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  await mkdir(dirname(paths[2].path), { recursive: true });
  await writeFile(paths[2].path, '[broken');
  await assert.rejects(configure(options));
  await assert.rejects(readFile(paths[0].path), { code: "ENOENT" });
  assert.equal(await readFile(paths[2].path, "utf8"), "[broken");
});
test("edits made between setup runs survive a later undo", async (t) => {
  const options = await fixture(t);
  await configure(options);
  const path = configPaths(options.home, options.env)[0].path;
  const value = JSON.parse(await readFile(path, "utf8"));
  value.model = "chosen-after-setup";
  await writeFile(path, JSON.stringify(value));
  await configure(options);
  await configure({ ...options, undo: true });
  const restored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(restored.model, value.model);
  assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, undefined);
});
test("models only writes no MCP entry, leaves ~/.claude.json alone and drops a previous one", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  const models = { modelUrl: credentials.modelUrl, modelKey: credentials.modelKey };
  const existing = '{"mcpServers":{"other":{"command":"other"}}}\n';
  await mkdir(dirname(paths[1].path), { recursive: true });
  await writeFile(paths[1].path, existing);
  await configure({ ...options, credentials: models });
  assert.equal(await readFile(paths[1].path, "utf8"), existing);
  const codex = decode(await readFile(paths[2].path, "utf8"), "toml");
  assert.equal(codex.model_providers.signalbox.http_headers["X-Api-Key"], credentials.modelKey);
  assert.equal(codex.mcp_servers, undefined);
  // A rerun after a setup with tools removes the tools entries it wrote.
  await configure(options);
  assert.ok(JSON.parse(await readFile(paths[1].path, "utf8")).mcpServers.signalbox);
  await configure({ ...options, credentials: models });
  assert.equal(JSON.parse(await readFile(paths[1].path, "utf8")).mcpServers.signalbox, undefined);
  assert.equal(decode(await readFile(paths[2].path, "utf8"), "toml").mcp_servers?.signalbox, undefined);
  assert.equal(await readFile(paths[1].path, "utf8"), existing);
  await configure({ ...options, undo: true });
  assert.equal(await readFile(paths[1].path, "utf8"), existing);
});
test("going models only removes a ~/.claude.json that setup created", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  await configure(options);
  await configure({ ...options, credentials: { modelUrl: credentials.modelUrl, modelKey: credentials.modelKey } });
  await assert.rejects(readFile(paths[1].path), { code: "ENOENT" });
  await configure({ ...options, undo: true });
  for (const file of paths) await assert.rejects(readFile(file.path), { code: "ENOENT" });
});
