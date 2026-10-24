import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { handleRequest } from "../router.ts";
import { brand } from "../../brand.ts";

// Protocol smoke only. No subscription, live backend, or Home acceptance is implied.
// Start Node normally; only native CLI processes acquire the machine's heavy slot.
const enabled = process.env.RUN_CLIENT_SMOKE === "1";
const marker = "local-protocol-smoke-ok";
const modelKey = "synthetic-model-key", toolsToken = "synthetic-tools-token";
const sourceHash = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
const exists = (path: string) => access(path).then(() => true, () => false);
async function binary(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const path = join(directory, name);
    if (await exists(path)) return path;
  }
}
type Json = Record<string, any>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
function stream(events: Json[]): Response {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
function anthropic(model: string, tool?: string): Response {
  const block = tool ? { type: "tool_use", id: "tool_smoke", name: tool, input: {} }
    : { type: "text", text: "" };
  const delta = tool ? { type: "input_json_delta", partial_json: '{"query":"smoke"}' }
    : { type: "text_delta", text: marker };
  return stream([
    { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
}
function responses(model: string, tool?: string, namespace?: string): Response {
  const item = tool ? { type: "function_call", id: "fc_smoke", call_id: "call_smoke", name: tool, namespace,
    arguments: '{"query":"smoke"}', status: "completed" }
    : { type: "message", id: "msg_smoke", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: marker, annotations: [] }] };
  const response = { id: "resp_smoke", object: "response", created_at: Math.floor(Date.now() / 1000),
    model, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  const events: Json[] = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
  ];
  if (tool) events.push({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0,
    arguments: item.arguments });
  else events.push({ type: "response.output_text.delta", item_id: item.id, output_index: 0,
    content_index: 0, delta: marker });
  events.push({ type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response });
  return stream(events.map((event, sequence_number) => ({ ...event, sequence_number })));
}
async function peer(jwt: string) {
  const trace: Json[] = [], failures: string[] = [];
  let searches = 0, turns = 0;
  const pool = { async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/__setup/v1/observed") return json({ success: true });
    const body: Json = request.method === "POST" ? await request.json() : {};
    const definitions = body.tools ?? [];
    const tools = definitions.map((tool: Json) => tool.name ?? tool.function?.name);
    trace.push({ service: "pool", path, method: request.method, model: body.model, tools,
      bearer: request.headers.get("authorization") === `Bearer ${modelKey}`,
      syntheticChatgptBearer: request.headers.get("authorization") === `Bearer ${jwt}`,
      apiKey: request.headers.get("x-api-key") === modelKey,
      definitions: definitions.filter((tool: Json) => tool.name?.includes("signalbox")),
      toolResultReturned: (body.messages ?? []).some((message: Json) => Array.isArray(message.content) &&
        message.content.some((content: Json) => content.type === "tool_result" && JSON.stringify(content.content).includes(marker))) ||
        (Array.isArray(body.input) && body.input.some((item: Json) => item.type === "function_call_output" && JSON.stringify(item.output).includes(marker))),
      toolOutputs: (Array.isArray(body.input) ? body.input : []).filter((item: Json) => item.type === "function_call_output") });
    if (path === "/v1/models" && request.headers.get("x-api-key") === modelKey) return json({ models: [] });
    if (path === "/v1/models") return json({ object: "list", data: ["claude-sonnet-4-6", "gpt-5.4"].map((id) =>
      ({ id, object: "model", type: "model", display_name: id, created: 1, created_at: "2026-01-01T00:00:00Z" })) });
    const firstTurn = ++turns === 1;
    if (turns > 4) { failures.push("Local peer exceeded four model turns"); return json({ error: "Turn limit" }, 400); }
    const tool = firstTurn ? tools.find((name: string) => name?.includes("signalbox") && name.endsWith("search")) : undefined;
    if (path === "/v1/messages") return anthropic(body.model, tool);
    if (path === "/v1/responses") {
      const namespace = firstTurn ? definitions.find((entry: Json) => entry.type === "namespace" && entry.name === "mcp__signalbox") : undefined;
      return responses(body.model, namespace?.tools?.find((entry: Json) => entry.name === "search")?.name ?? tool, namespace?.name);
    }
    failures.push(`Unexpected model path ${path}`);
    return json({ error: "Unexpected local model route" }, 404);
  } };
  const tools = { async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body: Json = await request.json();
    const authenticated = request.headers.get("authorization") === `Bearer ${toolsToken}`;
    trace.push({ service: "tools", path, method: body.method, name: body.params?.name, authenticated });
    if (path === "/mcp" && !authenticated) return json({ error: "Missing fixture bearer" }, 401);
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: Json = {};
    if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "local-protocol-peer", version: "1.0.0" } };
    else if (body.method === "tools/list") result = { tools: path === "/other" ? [] : [{ name: "search",
      description: "Search the local smoke fixture", annotations: { readOnlyHint: true, destructiveHint: false,
        idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object",
        properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] };
    else if (body.method === "tools/call") {
      assert.equal(path, "/mcp"); assert.equal(body.params.name, "search");
      assert.equal(body.params.arguments.query, "smoke"); searches++;
      result = { content: [{ type: "text", text: marker }], isError: false };
    } else if (body.method !== "ping") return json({ jsonrpc: "2.0", id: body.id,
      error: { code: -32601, message: "Method not supported by the local fixture" } });
    return json({ jsonrpc: "2.0", id: body.id, result });
  } };
  const pending: Promise<unknown>[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`http://127.0.0.1:${(server.address() as any).port}${req.url}`, {
        method: req.method, headers: req.headers as Record<string, string>,
        ...(["GET", "HEAD"].includes(req.method!) ? {} : { body: Buffer.concat(chunks) }),
      });
      const response = await handleRequest(request, { CATALOG_SERVICE: { fetch: async () => new Response(null, { status: 404 }) }, POOL_SERVICE: pool, TOOLS_SERVICE: tools,
        POOL_APP_SIGNING_KEY: "a".repeat(64) }, { waitUntil(work) { pending.push(work); } });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { failures.push(String(error)); res.writeHead(500); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { origin: `http://127.0.0.1:${(server.address() as any).port}`, trace, failures,
    get searches() { return searches; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(pending); } };
}
async function launch(binaryPath: string, args: string[], env: Record<string, string>, cwd: string) {
  const heavy = await binary("heavy-slot"), sandbox = await binary("sandbox-exec"), cleanEnv = await binary("env");
  assert.ok(heavy && sandbox && cleanEnv, "heavy-slot, sandbox-exec and env are required");
  // Seatbelt prevents default provider/telemetry APIs from reaching the internet.
  const protectedPaths = [".claude", ".codex", ".signalbox/userdata", ".t3/userdata", "Library/Keychains"]
    .map((path) => `(subpath ${JSON.stringify(join(process.env.HOME!, path))})`).join(" ");
  const profile = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))'
    + `(deny file-read* file-write* ${protectedPaths})`;
  const child = spawn(heavy, [cleanEnv, "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    sandbox, "-p", profile, binaryPath, ...args], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGTERM"); } catch {} }, 90_000);
  try { const [code, signal] = await once(child, "close"); return { pid: child.pid, code, signal, stdout, stderr, timedOut }; }
  finally { clearTimeout(timer); }
}
for (const client of ["claude", "codex"]) for (const seed of ["clean", "existing"]) {
  test(`installed ${client} loads generated ${seed} config through router`, { skip: !enabled, timeout: 110_000 }, async (t) => {
    const cli = await binary(client);
    if (!cli) { t.skip(`${client} is not installed`); return; }
    const home = await mkdtemp(join(tmpdir(), "installed-cli-smoke-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", HOME: home,
      TMPDIR: join(home, "tmp"), CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") };
    const cwd = join(home, "work");
    for (const directory of [cwd, env.TMPDIR, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) await mkdir(directory, { recursive: true });
    // Deliberately unsigned, synthetic ChatGPT identity. Never access a real login.
    const jwt = [ { alg: "RS256", typ: "JWT" }, { sub: "fixture-user", email: "fixture@example.invalid",
      exp: Math.floor(Date.now() / 1000) + 86400, "https://api.openai.com/auth": {
        chatgpt_account_id: "fixture-account", chatgpt_user_id: "fixture-user", chatgpt_plan_type: "plus" } } ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".synthetic";
    const stack = await peer(jwt);
    t.after(() => stack.close());
    const paths = [{ kind: "claude", path: join(env.CLAUDE_CONFIG_DIR, "settings.json"), format: "json" },
      { kind: "claudeMcp", path: join(env.CLAUDE_CONFIG_DIR, ".claude.json"), format: "json" },
      { kind: "codex", path: join(env.CODEX_HOME, "config.toml"), format: "toml" }];
    if (seed === "existing") {
      const originals = [JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: "old-fixture" },
        model: "claude-sonnet-4-6" }), JSON.stringify({ mcpServers: { other: { type: "http", url: `${stack.origin}/other` } } }),
        `model_provider = "other"\n[model_providers.other]\nname="Other"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\n[mcp_servers.other]\nurl="${stack.origin}/other"\n`];
      for (const [i, path] of paths.entries()) await writeFile(path.path, originals[i]);
    }
    const payload = join(home, "setup.json");
    await writeFile(payload, JSON.stringify({ version: 1, brand, credentials: { modelUrl: stack.origin, modelKey,
      toolsUrl: `${stack.origin}/mcp`, toolsToken } }), { mode: 0o600 });
    const installer = await launch(process.execPath, [fileURLToPath(new URL("./client.mjs", import.meta.url)), "--payload-file", payload], env, cwd);
    assert.equal(installer.code, 0, installer.stderr);
    assert.equal(installer.timedOut, false);
    const generated = await Promise.all(paths.map(async (file) => {
      const source = await readFile(file.path, "utf8");
      return { kind: file.kind, source, value: file.format === "json" ? JSON.parse(source) : parse(source) };
    }));
    const codex = generated[2].value;
    assert.equal(codex.model_providers.signalbox.requires_openai_auth, true);
    assert.equal(codex.model_providers.signalbox.http_headers["X-Api-Key"], modelKey);
    if (seed === "existing") {
      assert.ok(codex.model_providers.other); assert.ok(codex.mcp_servers.other);
      assert.ok(generated[1].value.mcpServers.other);
    }
    if (client === "codex") await writeFile(join(env.CODEX_HOME, "auth.json"), JSON.stringify({ auth_mode: "chatgpt",
      tokens: { id_token: jwt, access_token: jwt, refresh_token: "synthetic-refresh", account_id: "fixture-account" },
      last_refresh: new Date().toISOString() }), { mode: 0o600 });
    const prompt = "Call signalbox search with query smoke, then reply local-protocol-smoke-ok.";
    const args = client === "claude" ? ["--bare", "--print", "--no-session-persistence", "--setting-sources", "",
      "--settings", paths[0].path, "--strict-mcp-config", "--mcp-config", paths[1].path,
      "--tools", "", "--allowedTools", "mcp__signalbox__search", "--model", "claude-sonnet-4-6", "--output-format", "json", prompt]
      : ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "apps",
        "--model", "gpt-5.4", "--json", prompt];
    const result = await launch(cli, args, env, cwd);
    const report = { client, seed, binary: cli, sourceHash, installer, generated, trace: stack.trace, peerFailures: stack.failures, searches: stack.searches,
      ...result, stdout: result.stdout.replaceAll(jwt, "[synthetic-jwt]"), stderr: result.stderr.replaceAll(jwt, "[synthetic-jwt]") };
    if (process.env.CLI_SMOKE_ARTIFACT_DIR) {
      const directory = process.env.CLI_SMOKE_ARTIFACT_DIR; await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${client}-${seed}-${Date.now()}.json`), JSON.stringify(report, null, 2));
    }
    t.diagnostic(JSON.stringify({ client, seed, code: result.code, timedOut: result.timedOut,
      requests: stack.trace.length, searches: stack.searches, stderr: result.stderr.slice(-1500) }));
    assert.equal(result.timedOut, false, "CLI timed out");
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(stack.failures, []);
    const requests = stack.trace.filter((entry) => entry.service === "pool" && entry.method === "POST");
    assert.ok(requests.some((entry) => entry.path === (client === "claude" ? "/v1/messages" : "/v1/responses")));
    assert.ok(requests.every((entry) => client === "claude" ? entry.bearer : entry.apiKey && entry.syntheticChatgptBearer));
    assert.ok(requests.some((entry) => entry.toolResultReturned), "CLI must return the MCP result to its model");
    assert.ok(stack.searches > 0, "Native CLI must call signalbox search over MCP");
    assert.ok(stack.trace.some((entry) => entry.method === "tools/call" && entry.authenticated));
    if (seed === "existing") assert.ok(stack.trace.some((entry) => entry.path === "/other" && entry.method === "initialize"));
    if (client === "claude") assert.equal(JSON.parse(result.stdout).result, marker);
    else {
      const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === "item.completed" && event.item.type === "agent_message" && event.item.text === marker));
      assert.ok(events.some((event) => event.type === "item.completed" && event.item.type === "mcp_tool_call" &&
        event.item.server === "signalbox" && event.item.tool === "search" && event.item.status === "completed"));
    }
  });
}
