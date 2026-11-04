import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "../../brand.ts";
import { parse } from "smol-toml";

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

async function existingConnections(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "installer-existing-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
  await mkdir(env.CLAUDE_CONFIG_DIR);
  await mkdir(env.CODEX_HOME);
  const originals = {
    settings: '{"env":{"ANTHROPIC_BASE_URL":"https://old.invalid","ANTHROPIC_AUTH_TOKEN":"synthetic-old-model"},"model":"chosen-model"}\n',
    mcp: '{"mcpServers":{"executor":{"url":"https://old.invalid/mcp","headers":{"Authorization":"synthetic-old-tools"}},"old-tools":{"url":"https://alias.invalid/mcp"},"local":{"command":"local-tool"}},"keep":"value"}\n',
    codex: '# original\r\nmodel_provider="old"\r\n[mcp_servers.executor]\r\nurl="https://old.invalid/mcp"\r\n[mcp_servers.old-tools]\r\nurl="https://alias.invalid/mcp"\r\n[mcp_servers.local]\r\ncommand="local-tool"\r\n',
    auth: '{"synthetic":"provider-login-sentinel"}\n',
  };
  const paths = {
    settings: join(env.CLAUDE_CONFIG_DIR, "settings.json"),
    mcp: join(env.CLAUDE_CONFIG_DIR, ".claude.json"),
    codex: join(env.CODEX_HOME, "config.toml"),
    auth: join(env.CODEX_HOME, "auth.json"),
  };
  for (const name of ["settings", "mcp", "codex", "auth"] as const) await writeFile(paths[name], originals[name]);
  const payload = join(home, "payload.json");
  await writeFile(payload, JSON.stringify({ version: 1, brand, credentials: { modelUrl: "http://127.0.0.1:8317", modelKey: "fixture-model-credential", toolsUrl: "http://127.0.0.1:8787/mcp", toolsToken: "fixture-tools-credential" } }), { mode: 0o600 });
  return { home, env, originals, paths, payload };
}

for (const choice of ["replace", "keep"]) test(`installer ${choice} choice is explicit and one-command undo restores every file`, async (t) => {
  const f = await existingConnections(t);
  const flags = choice === "replace" ? ["--replace-mcp", "executor", "--replace-mcp", "old-tools"] : ["--keep-mcp"];
  const installed = await run(process.execPath, [client, "--payload-file", f.payload, ...flags], { cwd: f.home, env: f.env });
  assert.doesNotMatch(installed.stdout + installed.stderr, /synthetic-old|fixture-(model|tools)-credential/);
  const claude = JSON.parse(await readFile(f.paths.mcp, "utf8")).mcpServers;
  const codex = parse(await readFile(f.paths.codex, "utf8")).mcp_servers;
  for (const servers of [claude, codex]) {
    assert.ok(servers.signalbox);
    assert.ok(servers.local);
    assert.equal(Boolean(servers.executor), choice === "keep");
    assert.equal(Boolean(servers["old-tools"]), choice === "keep");
  }
  assert.equal(await readFile(f.paths.auth, "utf8"), f.originals.auth);
  await run(process.execPath, [client, "--undo"], { cwd: f.home, env: f.env });
  for (const name of ["settings", "mcp", "codex", "auth"] as const) assert.equal(await readFile(f.paths[name], "utf8"), f.originals[name]);
});

test("piped setup asks the person before reading a payload or changing any file", async (t) => {
  const f = await existingConnections(t);
  const result = await run(process.execPath, [client, "--payload-file", join(f.home, "not-created.json")], { cwd: f.home, env: f.env }).catch((error) => error);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /Replace your old Executor connection with Signalbox \(recommended\)/);
  assert.match(result.stdout, /Keep both/);
  assert.match(result.stdout, /setup link has not been used/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-old|https:\/\/old.invalid/);
  for (const name of ["settings", "mcp", "codex", "auth"] as const) assert.equal(await readFile(f.paths[name], "utf8"), f.originals[name]);
  await assert.rejects(readFile(join(f.home, ".local", "state", brand.setup.id, "backups.json")), { code: "ENOENT" });
});

test("replacement undo restores old connections while preserving later unrelated edits", async (t) => {
  const f = await existingConnections(t);
  await run(process.execPath, [client, "--payload-file", f.payload, "--replace-mcp", "executor"], { cwd: f.home, env: f.env });
  const value = JSON.parse(await readFile(f.paths.mcp, "utf8"));
  value.later = "keep this";
  await writeFile(f.paths.mcp, JSON.stringify(value));
  await run(process.execPath, [client, "--undo"], { cwd: f.home, env: f.env });
  const restored = JSON.parse(await readFile(f.paths.mcp, "utf8"));
  assert.deepEqual(restored.mcpServers, JSON.parse(f.originals.mcp).mcpServers);
  assert.equal(restored.later, "keep this");
});

test("a setup rerun keeps approved old connections removed until undo", async (t) => {
  const f = await existingConnections(t);
  await run(process.execPath, [client, "--payload-file", f.payload, "--replace-mcp", "executor"], { cwd: f.home, env: f.env });
  await run(process.execPath, [client, "--payload-file", f.payload, "--keep-mcp"], { cwd: f.home, env: f.env });
  assert.equal(JSON.parse(await readFile(f.paths.mcp, "utf8")).mcpServers.executor, undefined);
  assert.equal(Object.hasOwn(Object(parse(await readFile(f.paths.codex, "utf8")).mcp_servers), "executor"), false);
  await run(process.execPath, [client, "--undo"], { cwd: f.home, env: f.env });
  assert.equal(await readFile(f.paths.mcp, "utf8"), f.originals.mcp);
  assert.equal(await readFile(f.paths.codex, "utf8"), f.originals.codex);
});

for (const choice of ["replace", "keep"]) test(`an unowned destination name needs an explicit ${choice} choice`, async (t) => {
  const f = await existingConnections(t);
  f.originals.mcp = '{"mcpServers":{"signalbox":{"command":"my-local-server"}}}\n';
  f.originals.codex = '[mcp_servers.signalbox]\ncommand="my-local-server"\n';
  await writeFile(f.paths.mcp, f.originals.mcp);
  await writeFile(f.paths.codex, f.originals.codex);
  const unanswered = await run(process.execPath, [client, "--payload-file", f.payload], { cwd: f.home, env: f.env }).catch((error) => error);
  assert.equal(unanswered.code, 2);
  const flags = choice === "replace" ? ["--replace-mcp", "signalbox"] : ["--keep-mcp"];
  await run(process.execPath, [client, "--payload-file", f.payload, ...flags], { cwd: f.home, env: f.env });
  await run(process.execPath, [client, "--payload-file", f.payload, "--keep-mcp"], { cwd: f.home, env: f.env });
  const claude = JSON.parse(await readFile(f.paths.mcp, "utf8")).mcpServers;
  const codex = parse(await readFile(f.paths.codex, "utf8")).mcp_servers;
  for (const servers of [claude, codex]) {
    if (choice === "keep") {
      assert.equal(servers.signalbox.command, "my-local-server");
      assert.ok(servers["signalbox-2"].url);
      assert.equal(servers["signalbox-3"], undefined);
    } else {
      assert.ok(servers.signalbox.url);
      assert.equal(servers.signalbox.command, undefined);
    }
  }
  await run(process.execPath, [client, "--undo"], { cwd: f.home, env: f.env });
  assert.equal(await readFile(f.paths.mcp, "utf8"), f.originals.mcp);
  assert.equal(await readFile(f.paths.codex, "utf8"), f.originals.codex);
});


test("keep on rerun preserves a replacement name reintroduced by the person", async (t) => {
  const f = await existingConnections(t);
  await run(process.execPath, [client, "--payload-file", f.payload, "--replace-mcp", "executor"], { cwd: f.home, env: f.env });
  const value = JSON.parse(await readFile(f.paths.mcp, "utf8"));
  value.mcpServers.executor = { command: "new-local-tool" };
  await writeFile(f.paths.mcp, JSON.stringify(value));
  await writeFile(f.paths.codex, (await readFile(f.paths.codex, "utf8")) + '\n[mcp_servers.executor]\ncommand="new-local-tool"\n');
  await run(process.execPath, [client, "--payload-file", f.payload, "--keep-mcp"], { cwd: f.home, env: f.env });
  assert.deepEqual(JSON.parse(await readFile(f.paths.mcp, "utf8")).mcpServers.executor, { command: "new-local-tool" });
  assert.deepEqual(parse(await readFile(f.paths.codex, "utf8")).mcp_servers, {
    executor: { command: "new-local-tool" },
    "old-tools": { url: "https://alias.invalid/mcp" },
    local: { command: "local-tool" },
    signalbox: { url: "http://127.0.0.1:8787/mcp", http_headers: { Authorization: "Bearer fixture-tools-credential" } },
  });
  await run(process.execPath, [client, "--undo"], { cwd: f.home, env: f.env });
  assert.deepEqual(JSON.parse(await readFile(f.paths.mcp, "utf8")).mcpServers.executor, { command: "new-local-tool" });
  assert.deepEqual(parse(await readFile(f.paths.codex, "utf8")).mcp_servers, {
    executor: { command: "new-local-tool" }, "old-tools": { url: "https://alias.invalid/mcp" }, local: { command: "local-tool" },
  });
});
