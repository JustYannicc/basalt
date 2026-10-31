import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { configure, configPaths, previewConfiguration } from "./files.mjs";
import { decode, encode } from "./config.mjs";
import { brand } from "../../brand.ts";

const credentials = {
  modelUrl: "http://127.0.0.1:8317",
  modelKey: "test-model-key",
  toolsUrl: "http://127.0.0.1:8787/mcp",
  toolsToken: "test-tools-token",
};
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
  assert.equal(codex.model_providers.signalbox.supports_websockets, true);
  assert.equal(codex.model_providers.signalbox.http_headers["X-Api-Key"], credentials.modelKey);
  assert.equal((await stat(paths[2].path)).mode & 0o777, 0o600);
  await configure({ ...options, undo: true });
  for (const file of paths) await assert.rejects(readFile(file.path), { code: "ENOENT" });
});
test("setup enables Codex WebSockets and undo restores the previous transport preference", async (t) => {
  const options = await fixture(t);
  const path = configPaths(options.home, options.env)[2].path;
  const original = '[model_providers.signalbox]\nname = "Old pool"\nsupports_websockets = false\n';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, original);
  await configure(options);
  await configure(options);
  assert.equal(
    decode(await readFile(path, "utf8"), "toml").model_providers.signalbox.supports_websockets,
    true,
  );
  await configure({ ...options, undo: true });
  assert.equal(await readFile(path, "utf8"), original);
});
test("another proxy, providers, servers and CRLF restore byte for byte after rerun and rename", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  const originals = [
    '{\r\n "env": {"ANTHROPIC_BASE_URL":"https://other.invalid", "CUSTOM":"kept"}, "permissions":{"allow":["Read"]}, "model":"own-model"\r\n}\r\n',
    '{"mcpServers":{"other":{"command":"other"},"signalbox":{"command":"old-unmarked"}},"onboarding":true}\n',
    '# personal config\r\nmodel_provider = "other"\r\nmodel = "own-model"\r\n[model_providers.other]\r\nname="Other"\r\nbase_url="https://other.invalid"\r\n[mcp_servers.other]\r\ncommand="other"\r\n',
  ];
  for (const [i, file] of paths.entries()) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, originals[i]);
  }
  await configure(options);
  await configure({
    ...options,
    brand: {
      ...brand,
      name: "Renamed",
      mcpServerName: "renamed",
      setup: { ...brand.setup, marker: "Renamed managed computer setup" },
    },
  });
  const codex = decode(await readFile(paths[2].path, "utf8"), "toml");
  assert.equal(codex.model_provider, "renamed");
  assert.ok(codex.model_providers.other);
  assert.ok(codex.mcp_servers.other);
  assert.equal(codex.model_providers.signalbox, undefined);
  await configure({ ...options, undo: true });
  for (const [i, file] of paths.entries())
    assert.deepEqual(await readFile(file.path), Buffer.from(originals[i]));
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
  await writeFile(paths[2].path, "[broken");
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
  assert.equal(
    decode(await readFile(paths[2].path, "utf8"), "toml").mcp_servers?.signalbox,
    undefined,
  );
  assert.equal(await readFile(paths[1].path, "utf8"), existing);
  await configure({ ...options, undo: true });
  assert.equal(await readFile(paths[1].path, "utf8"), existing);
});
test("going models only removes a ~/.claude.json that setup created", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  await configure(options);
  await configure({
    ...options,
    credentials: { modelUrl: credentials.modelUrl, modelKey: credentials.modelKey },
  });
  await assert.rejects(readFile(paths[1].path), { code: "ENOENT" });
  await configure({ ...options, undo: true });
  for (const file of paths) await assert.rejects(readFile(file.path), { code: "ENOENT" });
});

test("preview is read only and selected local agents share one undo manifest with separate keys", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  const auth = join(dirname(paths[2].path), "auth.json");
  await mkdir(dirname(auth), { recursive: true });
  const login = '{"tokens":{"access_token":"existing-chatgpt-login"}}\n';
  await writeFile(auth, login);
  const clients = {
    claude: { ...credentials, modelKey: "local-claude", toolsToken: "local-claude" },
    codex: { ...credentials, modelKey: "local-codex", toolsToken: "local-codex" },
  };
  const preview = await previewConfiguration({ ...options, clients });
  assert.deepEqual(preview.configured, { claude: false, codex: false });
  assert.equal(preview.files.length, 3);
  assert.ok(preview.files.every((file) => file.action === "update"));
  assert.ok(!JSON.stringify(preview).includes("local-codex"));
  for (const file of paths) await assert.rejects(readFile(file.path), { code: "ENOENT" });
  await assert.rejects(
    readFile(join(options.home, ".local", "state", brand.setup.id, "backups.json")),
    { code: "ENOENT" },
  );
  await configure({ ...options, clients, expectedRevision: preview.revision });
  const claude = JSON.parse(await readFile(paths[0].path, "utf8"));
  const codex = decode(await readFile(paths[2].path, "utf8"), "toml");
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, "local-claude");
  assert.equal(codex.model_providers.signalbox.http_headers["X-Api-Key"], "local-codex");
  assert.equal(codex.mcp_servers.signalbox.http_headers.Authorization, "Bearer local-codex");
  assert.equal(codex.model_providers.signalbox.requires_openai_auth, true);
  assert.equal(await readFile(auth, "utf8"), login);
  await configure({ ...options, undo: true });
  for (const file of paths) await assert.rejects(readFile(file.path), { code: "ENOENT" });
  assert.equal(await readFile(auth, "utf8"), login);
});

test("adding Codex explicitly keeps remote Claude settings and undo retains their original backup", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  const original = '{\r\n "model": "personal", "env": {"CUSTOM":"kept"}\r\n}\r\n';
  await mkdir(dirname(paths[0].path), { recursive: true });
  await writeFile(paths[0].path, original);
  await configure({ ...options, clients: { claude: credentials } });
  const current = await readFile(paths[0].path, "utf8");
  const clients = { claude: "keep", codex: { ...credentials, modelKey: "local-codex" } };
  const preview = await previewConfiguration({ ...options, clients });
  assert.equal(preview.files.find((file) => file.kind === "claude").action, "keep");
  await configure({ ...options, clients, expectedRevision: preview.revision });
  assert.equal(await readFile(paths[0].path, "utf8"), current);
  await configure({ ...options, clients });
  assert.equal(await readFile(paths[0].path, "utf8"), current);
  await configure({ ...options, undo: true });
  assert.equal(await readFile(paths[0].path, "utf8"), original);
  for (const file of paths.slice(1)) await assert.rejects(readFile(file.path), { code: "ENOENT" });
});

test("deselecting an agent restores its bytes while retaining the selected agent and later user edits", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  const original = '{"model":"mine"}\r\n';
  await mkdir(dirname(paths[0].path), { recursive: true });
  await writeFile(paths[0].path, original);
  await configure(options);
  const source = decode(await readFile(paths[2].path, "utf8"), "toml");
  source.model = "later-model";
  await writeFile(paths[2].path, encode(source, "toml"));
  const clients = { codex: "keep" };
  const preview = await previewConfiguration({ ...options, clients });
  assert.equal(preview.files.find((file) => file.kind === "claude").action, "restore");
  await configure({ ...options, clients, expectedRevision: preview.revision });
  assert.equal(await readFile(paths[0].path, "utf8"), original);
  await assert.rejects(readFile(paths[1].path), { code: "ENOENT" });
  assert.equal(
    decode(await readFile(paths[2].path, "utf8"), "toml").model_providers.signalbox.http_headers[
      "X-Api-Key"
    ],
    credentials.modelKey,
  );
  await configure({ ...options, undo: true });
  assert.equal(await readFile(paths[0].path, "utf8"), original);
  assert.equal(
    decode(await readFile(paths[2].path, "utf8"), "toml").mcp_servers?.signalbox,
    undefined,
  );
  assert.equal(decode(await readFile(paths[2].path, "utf8"), "toml").model, "later-model");
});

test("a preview refuses malformed files and a changed configuration cannot be applied", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  const preview = await previewConfiguration(options);
  await mkdir(dirname(paths[2].path), { recursive: true });
  await writeFile(paths[2].path, 'model = "changed-after-preview"\n');
  await assert.rejects(
    configure({ ...options, expectedRevision: preview.revision }),
    /changed after preview/,
  );
  await assert.rejects(readFile(paths[0].path), { code: "ENOENT" });
  await writeFile(paths[2].path, "[broken");
  await assert.rejects(previewConfiguration(options));
  assert.equal(await readFile(paths[2].path, "utf8"), "[broken");
});

test("tools-only local setup preserves model choice and models-only has no MCP entries", async (t) => {
  const options = await fixture(t);
  const paths = configPaths(options.home, options.env);
  const original = 'model_provider = "personal"\n';
  await mkdir(dirname(paths[2].path), { recursive: true });
  await writeFile(paths[2].path, original);
  await configure({
    ...options,
    clients: { codex: { toolsUrl: credentials.toolsUrl, toolsToken: "local-codex" } },
  });
  const tools = decode(await readFile(paths[2].path, "utf8"), "toml");
  assert.equal(tools.model_provider, "personal");
  assert.equal(tools.model_providers, undefined);
  assert.equal(tools.mcp_servers.signalbox.http_headers.Authorization, "Bearer local-codex");
  await configure({
    ...options,
    clients: { codex: { modelUrl: credentials.modelUrl, modelKey: "local-model-only" } },
  });
  assert.equal(
    decode(await readFile(paths[2].path, "utf8"), "toml").mcp_servers?.signalbox,
    undefined,
  );
  await configure({ ...options, undo: true });
  assert.equal(await readFile(paths[2].path, "utf8"), original);
});
