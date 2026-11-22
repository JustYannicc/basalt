import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { createNativePreviewSession, type NativeClient, type NativePreviewSession, type NativeSetupPayload } from "./preview-native.ts";

type Trace = Record<string, unknown>;

function payload(origin: string, options: { setupId?: string; modelUrl?: string; toolsUrl?: string } = {}): NativeSetupPayload {
  return {
    version: 1,
    brand: { name: "Preview Brand", mcpServerName: "signalbox", setup: { id: options.setupId ?? "preview-setup", marker: "setup marker" } },
    instructions: "Local test payload",
    credentials: {
      modelUrl: options.modelUrl ?? origin,
      modelKey: "fixture-model-key",
      toolsUrl: options.toolsUrl ?? `${origin}/mcp`,
      toolsToken: "fixture-tools-token",
    },
  };
}

function installerSource(tracePath: string, options: { failInstall?: boolean; brokenUndo?: boolean }): string {
  return `import { appendFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
const trace = ${JSON.stringify(tracePath)};
const args = process.argv.slice(2);
const record = async (value) => appendFile(trace, JSON.stringify(value) + "\\n");
const claude = process.env.CLAUDE_CONFIG_DIR;
const codex = process.env.CODEX_HOME;
const paths = [claude + "/settings.json", claude + "/.claude.json", codex + "/config.toml"];
if (args[0] === "--payload-file") {
  const payload = JSON.parse(await readFile(args[1], "utf8"));
  await mkdir(claude, { recursive: true }); await mkdir(codex, { recursive: true });
  await Promise.all(paths.map((path, index) => writeFile(path, "owned-" + index, { mode: 0o600 })));
  const mode = async (path) => (await lstat(path)).mode & 0o777;
  const authMode = await lstat(codex + "/auth.json").then(value => value.mode & 0o777, () => null);
  await record({ kind: "install", args, home: process.env.HOME, installer: process.argv[1], payloadMode: await mode(args[1]), installerMode: await mode(process.argv[1]), authMode,
    payloadVersion: payload.version, origin: payload.credentials.modelUrl });
  process.stderr.write("PRIVATE_INSTALLER_DIAGNOSTIC");
  ${options.failInstall ? "process.exitCode = 23;" : ""}
} else if (args[0] === "--undo") {
  const existing = await Promise.all(paths.map(path => lstat(path).then(() => true, () => false)));
  ${options.brokenUndo ? "" : "await Promise.all(paths.map(path => rm(path, { force: true })));"}
  await record({ kind: "undo", args, home: process.env.HOME, installer: process.argv[1], foundConfig: existing.some(Boolean) });
  process.stderr.write("PRIVATE_UNDO_DIAGNOSTIC");
} else { process.exitCode = 24; }
`;
}

function cliSource(tracePath: string, client: NativeClient, marker: string, wrongReply: boolean, searchArgs: unknown): string {
  const events = client === "claude"
    ? [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__signalbox__search",
        ...(searchArgs === undefined ? {} : { input: searchArgs }) }] } },
      { type: "result", result: wrongReply ? "wrong-preview-reply" : marker },
    ]
    : [
      { type: "item.completed", item: { type: "mcp_tool_call", server: "signalbox", tool: "search",
        ...(searchArgs === undefined ? {} : { arguments: searchArgs }), status: "completed" } },
      { type: "item.completed", item: { type: "agent_message", text: wrongReply ? "wrong-preview-reply" : marker } },
    ];
  return `#!/usr/bin/env node
const fs = require("node:fs/promises");
const trace = ${JSON.stringify(tracePath)};
const record = { kind: "cli", args: process.argv.slice(2), home: process.env.HOME,
  claudeHome: process.env.CLAUDE_CONFIG_DIR, codexHome: process.env.CODEX_HOME,
  temp: process.env.TMPDIR, xdg: process.env.XDG_CONFIG_HOME,
  inheritedProviderKey: process.env.ANTHROPIC_API_KEY !== undefined || process.env.OPENAI_API_KEY !== undefined,
  inheritedSdkSetting: process.env.OPENAI_BASE_URL !== undefined || process.env.ANTHROPIC_BASE_URL !== undefined };
(async () => { await fs.appendFile(trace, JSON.stringify(record) + "\\n");
  process.stderr.write("PRIVATE_CLI_DIAGNOSTIC");
  process.stdout.write(${JSON.stringify(events.map(event => JSON.stringify(event)).join("\n") + "\n")});
})().catch(() => { process.exitCode = 25; });
`;
}

async function readTrace(path: string): Promise<Trace[]> {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function fixture(t: TestContext, client: NativeClient, options: {
  failInstall?: boolean;
  brokenUndo?: boolean;
  wrongReply?: boolean;
  searchArgs?: unknown;
  setupId?: string;
  modelUrl?: string;
  toolsUrl?: string;
} = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "pool-native-test-"));
  const bin = join(scratch, "bin");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin, { mode: 0o700 }));
  const tracePath = join(scratch, "trace.jsonl");
  const marker = "pool-preview-marker-unique-47a91";
  const searchArgs = Object.hasOwn(options, "searchArgs") ? options.searchArgs : { query: "pool", limit: 1 };
  const cliFile = join(bin, client);
  await writeFile(cliFile, cliSource(tracePath, client, marker, options.wrongReply ?? false, searchArgs), { mode: 0o700 });
  await chmod(cliFile, 0o700);

  const downloaded: string[] = [];
  const server = createServer(async (request, response) => {
    downloaded.push(`${request.method} ${request.url}`);
    if (request.method !== "GET" || request.url !== "/setup/client.mjs") {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(installerSource(tracePath, options));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${originalPath ?? "/usr/bin:/bin"}`;
  let authFile: string | undefined;
  if (client === "codex") {
    authFile = join(scratch, "auth.json");
    await writeFile(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: {
      id_token: "dedicated-export-id", access_token: "dedicated-export-access", refresh_token: "dedicated-export-refresh",
    } }), { mode: 0o600 });
    await chmod(authFile, 0o600);
  }
  const restore = async () => {
    process.env.PATH = originalPath;
    server.closeAllConnections();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(scratch, { recursive: true, force: true });
  };
  let session: NativePreviewSession;
  try {
    session = await createNativePreviewSession({ client, model: client === "claude" ? "claude-preview-model" : "codex-preview-model",
      payload: payload(origin, options), codexAuthFile: authFile, marker, origin });
  } catch (error) {
    await restore();
    throw error;
  }

  t.after(async () => {
    await session.dispose().catch(() => {});
    await restore();
  });
  return { session, scratch, tracePath, marker, origin, downloaded };
}

test("Claude preview downloads the public installer and proves a native MCP event plus exact reply", async t => {
  const parentHome = process.env.HOME;
  const f = await fixture(t, "claude");
  assert.deepEqual(await f.session.run(), { modelReplyMatched: true, toolCallObserved: true });
  const trace = await readTrace(f.tracePath);
  assert.deepEqual(f.downloaded, ["GET /setup/client.mjs"]);
  const install = trace.find(value => value.kind === "install");
  const cli = trace.find(value => value.kind === "cli");
  assert.ok(install && cli);
  assert.deepEqual(install.args, ["--payload-file", (install.args as string[])[1]]);
  assert.equal(install.payloadMode, 0o600);
  assert.equal(install.installerMode, 0o600);
  assert.equal(install.origin, f.origin);
  assert.equal(cli.inheritedProviderKey, false);
  assert.equal(cli.inheritedSdkSetting, false);
  const nativeRoot = dirname(String(cli.home));
  assert.ok(basename(nativeRoot).startsWith("pool-native-preview-"));
  assert.equal(cli.claudeHome, join(nativeRoot, "claude"));
  assert.equal(cli.codexHome, join(nativeRoot, "codex"));
  assert.equal(cli.temp, join(nativeRoot, "tmp"));
  assert.equal(cli.xdg, join(nativeRoot, "xdg"));
  assert.deepEqual((cli.args as string[]).slice(0, 4), ["--bare", "--print", "--no-session-persistence", "--setting-sources"]);
  assert.ok((cli.args as string[]).includes("claude-preview-model"));
  assert.ok((cli.args as string[]).includes("mcp__signalbox__search"));
  assert.ok(String((cli.args as string[]).at(-1)).includes('{"query":"pool","limit":1}'));
  await f.session.undo();
  const undo = (await readTrace(f.tracePath)).find(value => value.kind === "undo");
  assert.deepEqual(undo?.args, ["--undo"]);
  assert.equal(undo?.installer, install.installer);
  assert.equal(undo?.foundConfig, true);
  await f.session.dispose();
  assert.equal(await exists(nativeRoot), false);
  assert.equal(process.env.HOME, parentHome);
});

test("Codex preview copies only the dedicated auth.json and parses its native MCP completion", async t => {
  const f = await fixture(t, "codex");
  assert.deepEqual(await f.session.run(), { modelReplyMatched: true, toolCallObserved: true });
  const trace = await readTrace(f.tracePath);
  const install = trace.find(value => value.kind === "install");
  const cli = trace.find(value => value.kind === "cli");
  assert.ok(install && cli);
  assert.equal(install.authMode, 0o600);
  assert.deepEqual((cli.args as string[]).slice(0, 8), ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "apps", "--model"]);
  assert.ok((cli.args as string[]).includes("codex-preview-model"));
  assert.ok((cli.args as string[]).includes("--json"));
  assert.ok(String((cli.args as string[]).at(-1)).includes('{"query":"pool","limit":1}'));
  assert.equal(cli.inheritedProviderKey, false);
  assert.equal(cli.inheritedSdkSetting, false);
  await f.session.undo();
  await f.session.dispose();
});

test("a partial installer failure runs the same downloaded installer's undo without launching a CLI", async t => {
  const f = await fixture(t, "codex", { failInstall: true });
  await assert.rejects(f.session.run(), error => {
    assert.match(String(error), /Native preview installer failed/);
    assert.doesNotMatch(String(error), /PRIVATE_INSTALLER_DIAGNOSTIC|fixture-model-key|dedicated-export/);
    return true;
  });
  const trace = await readTrace(f.tracePath);
  assert.deepEqual(trace.filter(value => value.kind === "undo").map(value => value.args), [["--undo"]]);
  assert.equal(trace.some(value => value.kind === "cli"), false);
  assert.equal(trace.find(value => value.kind === "undo")?.foundConfig, true);
  await f.session.dispose();
});

test("a mismatched final marker fails closed and remains undoable", async t => {
  const f = await fixture(t, "claude", { wrongReply: true });
  await assert.rejects(f.session.run(), error => {
    assert.match(String(error), /did not observe the expected model reply and MCP search/);
    assert.doesNotMatch(String(error), /PRIVATE_CLI_DIAGNOSTIC|wrong-preview-reply/);
    return true;
  });
  await f.session.undo();
  const cli = (await readTrace(f.tracePath)).find(value => value.kind === "cli");
  assert.ok(cli);
  const root = dirname(String(cli.home));
  await f.session.dispose();
  assert.equal(await exists(root), false);
});

test("Claude native evidence rejects a missing MCP search argument object", async t => {
  const f = await fixture(t, "claude", { searchArgs: undefined });
  await assert.rejects(f.session.run(), /did not observe the expected model reply and MCP search/);
  await f.session.undo();
  await f.session.dispose();
});

test("Codex native evidence rejects search arguments that differ from query pool and limit 1", async t => {
  const f = await fixture(t, "codex", { searchArgs: { query: "pool", limit: 2 } });
  await assert.rejects(f.session.run(), /did not observe the expected model reply and MCP search/);
  await f.session.undo();
  await f.session.dispose();
});

test("payload origin and setup identifier cannot redirect config or cleanup outside the isolated home", async t => {
  await assert.rejects(fixture(t, "claude", { modelUrl: "https://other.invalid" }), /payload origin does not match the stage/);
  await assert.rejects(fixture(t, "claude", { toolsUrl: "https://other.invalid/mcp" }), /payload origin does not match the stage/);
  await assert.rejects(fixture(t, "claude", { setupId: "../outside" }), /setup payload is invalid/);
});

test("failed undo is reported safely and dispose still deletes the isolated root", async t => {
  const f = await fixture(t, "claude", { failInstall: true, brokenUndo: true });
  await assert.rejects(f.session.run(), error => {
    assert.match(String(error), /cleanup could not be verified/);
    assert.doesNotMatch(String(error), /PRIVATE_UNDO_DIAGNOSTIC|owned-0/);
    return true;
  });
  const install = (await readTrace(f.tracePath)).find(value => value.kind === "install");
  assert.ok(install);
  const root = dirname(String(install.home));
  await assert.rejects(f.session.dispose(), /Native preview cleanup failed/);
  assert.equal(await exists(root), false);
});
