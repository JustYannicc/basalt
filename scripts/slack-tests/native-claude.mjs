import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { brand } from "../../brand.ts";

async function binary(name) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const path = join(directory, name);
    if (await access(path).then(() => true, () => false)) return path;
  }
  return undefined;
}

async function requireInstalledClaude() {
  const required = ["claude", "heavy-slot", "sandbox-exec", "env"];
  const found = Object.fromEntries(await Promise.all(required.map(async (name) => [name, await binary(name)])));
  const missing = required.filter((name) => !found[name]);
  assert.deepEqual(missing, [], `Installed Claude proof prerequisites are missing: ${missing.join(", ")}`);
  return found.claude;
}

async function launch(command, args, env, cwd, report) {
  const heavy = await binary("heavy-slot"), sandbox = await binary("sandbox-exec");
  const realHome = process.env.SLACK_PROTECTED_HOME;
  assert.ok(heavy && sandbox && realHome, "The isolated Claude CLI needs its local sandbox tools");
  const protectedPaths = [".claude", ".codex", ".signalbox/userdata", ".t3/userdata", "Library/Keychains"]
    .map((path) => `(subpath ${JSON.stringify(join(realHome, path))})`).join(" ");
  const profile = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))'
    + `(deny file-read* file-write* ${protectedPaths})`;
  const child = spawn(heavy, [await binary("env"), "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    sandbox, "-p", profile, command, ...args], {
    cwd,
    detached: true,
    env: { PATH: process.env.PATH ?? "", HOME: realHome, LANG: "en_US.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} }, 90_000);
  const killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 95_000);
  try {
    const [code] = await once(child, "close");
    await writeFile(report, JSON.stringify({ code, stdout, stderr, timedOut }), { mode: 0o600 });
    assert.equal(timedOut, false, "Installed Claude timed out");
    assert.equal(code, 0, "Installed Claude failed; private diagnostics retained");
    return stdout;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}

function modelMessage(model, turn, tool, input, text) {
  const events = [
    { type: "message_start", message: { id: `msg_slack_fixture_${turn}`, type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: `tool_slack_fixture_${turn}`, name: tool, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function containsText(value, expected, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    if (value.includes(expected)) return true;
    try { return containsText(JSON.parse(value), expected, depth + 1); } catch { return false; }
  }
  return typeof value === "object" && Object.values(value).some((item) => containsText(item, expected, depth + 1));
}

/** The installed CLI reads the real setup entry and calls the local self-host MCP endpoint. */
export async function proveInstalledClaude({
  root,
  directory,
  origin,
  token,
  slug,
  historyPath,
  postPath,
  historyAccountId,
  postAccountId,
  peerAccountId,
  userToken,
  marker,
  peerMarker,
  channel,
  postText,
  mock,
}) {
  const cli = await requireInstalledClaude();
  const home = join(directory, "native-claude");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: join(home, "tmp"),
    CODEX_HOME: join(home, "codex"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
  };
  const cwd = join(home, "work");
  for (const path of [cwd, env.TMPDIR, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR])
    await mkdir(path, { recursive: true, mode: 0o700 });
  let turns = 0;
  let historyPathReturned = false;
  let historyReadReturned = false;
  let postPathReturned = false;
  let postReturned = false;
  const completionText = "slack-local-proof-ok";
  const failures = [], trace = [];
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      trace.push({ path, method: request.method, authenticated: request.headers.authorization === "Bearer synthetic-model-key" });
      if (path === "/api/hello" && request.method === "HEAD") { response.writeHead(200); response.end(); return; }
      if (path === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ models: [] })); return; }
      assert.equal(path, "/v1/messages");
      assert.equal(request.headers.authorization, "Bearer synthetic-model-key");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const results = (body.messages ?? []).flatMap((entry) => Array.isArray(entry.content) ? entry.content : [])
        .filter((entry) => entry.type === "tool_result" && !entry.is_error);
      trace.push({ toolResults: (body.messages ?? []).flatMap((entry) => Array.isArray(entry.content) ? entry.content : []).filter((entry) => entry.type === "tool_result") });
      const offered = (body.tools ?? []).map((tool) => tool.name);
      const turn = ++turns;
      assert.ok(turn <= 5, "Claude exceeded five local model turns");
      let tool, input;
      if (turn === 1) {
        tool = offered.find((name) => name === "mcp__signalbox__search");
        assert.ok(tool, "Claude did not load the configured Signalbox search tool");
        input = { query: "conversations.history" };
      } else if (turn === 2) {
        historyPathReturned = results.some((entry) => containsText(entry.content, historyPath));
        assert.ok(historyPathReturned, "Signalbox search did not return conversations.history to Claude");
        assert.ok(results.some((entry) => containsText(entry.content, historyAccountId))
          && !results.some((entry) => containsText(entry.content, peerAccountId)),
        "Claude's history search did not select only its owner's Slack account");
        tool = offered.find((name) => name === "mcp__signalbox__call");
        assert.ok(tool, "Claude did not load the configured Signalbox call tool for the history read");
        input = { calls: { path: historyPath, input: {
          accountId: historyAccountId,
          input: { query: { channel } },
        } } };
      } else if (turn === 3) {
        historyReadReturned = results.some((entry) => containsText(entry.content, marker));
        assert.ok(historyReadReturned, "The real synthetic Slack history did not reach Claude");
        assert.ok(!results.some((entry) => containsText(entry.content, peerMarker)),
          "Claude's Slack history result included the peer account marker");
        tool = offered.find((name) => name === "mcp__signalbox__search");
        assert.ok(tool, "Claude did not load the configured Signalbox search tool for chat.postMessage");
        input = { query: "chat.postMessage" };
      } else if (turn === 4) {
        postPathReturned = results.some((entry) => containsText(entry.content, postPath));
        assert.ok(postPathReturned, "Signalbox search did not return chat.postMessage to Claude");
        assert.ok(results.some((entry) => containsText(entry.content, postAccountId))
          && !results.some((entry) => containsText(entry.content, peerAccountId)),
        "Claude's post search did not select only its owner's Slack account");
        tool = offered.find((name) => name === "mcp__signalbox__call");
        assert.ok(tool, "Claude did not load the approved Signalbox call tool for chat.postMessage");
        input = { calls: { path: postPath, input: {
          accountId: postAccountId,
          input: {
            contentType: "application/x-www-form-urlencoded",
            body: { channel, text: postText },
            headers: { token: userToken },
          },
        } } };
      } else {
        postReturned = results.some((entry) => containsText(entry.content, postText));
        assert.ok(postReturned, "The expected Slack post result did not return to Claude");
      }
      response.setHeader("content-type", "text/event-stream");
      response.end(modelMessage(body.model, turn, tool, input, completionText));
    } catch (error) {
      failures.push(String(error));
      response.writeHead(400);
      response.end('{"error":"local model fixture assertion failed"}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const payload = join(home, "setup.json");
    await writeFile(payload, JSON.stringify({ version: 1, brand, credentials: {
      modelUrl: `http://127.0.0.1:${server.address().port}`,
      modelKey: "synthetic-model-key",
      toolsUrl: `${origin}/mcp`,
      toolsToken: token,
    } }), { mode: 0o600 });
    await launch(process.execPath, [join(root, "src/setup/client.mjs"), "--payload-file", payload], env, cwd, join(home, "installer.json"));
    const settings = join(env.CLAUDE_CONFIG_DIR, "settings.json");
    const mcp = join(env.CLAUDE_CONFIG_DIR, ".claude.json");
    const config = JSON.parse(await readFile(mcp, "utf8"));
    assert.equal(config.mcpServers.signalbox.url, `${origin}/mcp`);
    const postsBefore = mock.observations().api.filter((item) => item.operation === "chat.postMessage");
    const output = await launch(cli, [
      "--bare", "--print", "--no-session-persistence", "--setting-sources", "",
      "--settings", settings, "--strict-mcp-config", "--mcp-config", mcp,
      "--tools", "", "--allowedTools", "mcp__signalbox__search", "mcp__signalbox__call",
      "--model", "claude-sonnet-4-6", "--output-format", "json",
      `Find the ${slug} app through Signalbox. Read conversations.history and confirm it contains ${marker}. Then discover chat.postMessage, post the exact text ${postText} to ${channel} using the connected owner's Slack user account, and reply ${completionText}.`,
    ], env, cwd, join(home, "claude.json"));
    assert.equal(JSON.parse(output).result, completionText);
    assert.deepEqual(failures, []);
    assert.ok(historyPathReturned && historyReadReturned && postPathReturned && postReturned);
    assert.equal(turns, 5);
    const postsAfter = mock.observations().api.filter((item) => item.operation === "chat.postMessage");
    assert.equal(postsAfter.length, postsBefore.length + 1,
      "Installed Claude did not produce exactly one Slack chat.postMessage call");
    assert.equal(postsAfter.at(-1)?.actor, "owner", "Installed Claude posted as the wrong Slack user");
    assert.equal(postsAfter.at(-1)?.authKind, "user", "Installed Claude posted with a bot or missing token");
    return {
      installedClaude: true,
      installedClaudeRead: true,
      installedClaudePost: true,
      installedClaudeModel: "local simulated Anthropic Messages API fixture",
    };
  } finally {
    await writeFile(join(home, "model-observations.json"), JSON.stringify({
      failures, trace, turns, historyPathReturned, historyReadReturned, postPathReturned, postReturned,
    }), { mode: 0o600 });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
