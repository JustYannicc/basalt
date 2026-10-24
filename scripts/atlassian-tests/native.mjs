import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { brand } from "../../brand.ts";
import { atlassianPeople } from "./provider.mjs";
import { nativeMarker, nativeModelKey, nativeModelName, startNativeModelFixture } from "./model-fixture.mjs";

async function binary(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(directory, name);
    if (await access(path).then(() => true, () => false)) return path;
  }
  return undefined;
}

async function launch(command, args, env, cwd, realHome, timeoutMs = 90_000) {
  const heavy = await binary("heavy-slot");
  const sandbox = await binary("sandbox-exec");
  const cleanEnv = await binary("env");
  assert.ok(heavy && sandbox && cleanEnv, "Native CLI proof requires heavy-slot, sandbox-exec and env");
  const protectedPaths = [".claude", ".codex", ".signalbox/userdata", ".t3/userdata", "Library/Keychains"]
    .map((path) => `(subpath ${JSON.stringify(join(realHome, path))})`).join(" ");
  const profile = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))'
    + `(deny file-read* file-write* ${protectedPaths})`;
  const child = spawn(heavy, [cleanEnv, "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    sandbox, "-p", profile, command, ...args], {
    cwd,
    detached: true,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: realHome, LANG: "en_US.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const timeout = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} }, timeoutMs);
  const kill = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutMs + 5000);
  try {
    const [code, signal] = await once(child, "close");
    return { code, signal, stdout, stderr, timedOut, pid: child.pid };
  } finally {
    clearTimeout(timeout);
    clearTimeout(kill);
  }
}

async function proveClient({ client, cli, root, directory, toolsOrigin, token, toolPaths, person, realHome }) {
  const home = join(directory, `native-${client}`);
  const work = join(home, "work");
  const temporary = join(home, "tmp");
  const claudeHome = join(home, "claude");
  const codexHome = join(home, "codex");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: temporary,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
  };
  for (const path of [work, temporary, claudeHome, codexHome]) await mkdir(path, { recursive: true, mode: 0o700 });

  const peer = atlassianPeople.find((candidate) => candidate.key !== person.key);
  assert.ok(peer, "Native proof needs a second synthetic Atlassian identity");
  const fixture = await startNativeModelFixture({ toolPaths, person, peer });
  try {
    const payload = join(home, "setup.json");
    await writeFile(payload, JSON.stringify({ version: 1, brand, credentials: {
      modelUrl: fixture.origin,
      modelKey: nativeModelKey,
      toolsUrl: toolsOrigin,
      toolsToken: token,
    } }), { mode: 0o600 });
    if (client === "codex") {
      const jwt = [
        { alg: "RS256", typ: "JWT" },
        { sub: "synthetic-codex-user", exp: Math.floor(Date.now() / 1000) + 3600,
          "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account", chatgpt_plan_type: "plus" } },
      ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".synthetic-codex-jwt";
      await writeFile(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt",
        tokens: { id_token: jwt, access_token: jwt, refresh_token: "synthetic-refresh", account_id: "synthetic-account" },
        last_refresh: new Date().toISOString() }), { mode: 0o600 });
    }

    const installer = await launch(process.execPath, [join(root, "src/setup/client.mjs"), "--payload-file", payload], env, work, realHome);
    assert.equal(installer.timedOut, false, `${client} setup timed out`);
    assert.equal(installer.code, 0, `${client} setup failed`);

    const args = client === "claude"
      ? ["--bare", "--print", "--no-session-persistence", "--setting-sources", "", "--settings", join(claudeHome, "settings.json"),
        "--strict-mcp-config", "--mcp-config", join(claudeHome, ".claude.json"), "--tools", "", "--allowedTools",
        "mcp__signalbox__search", "mcp__signalbox__call", "--model", "claude-sonnet-4-6", "--output-format", "json",
        `Find the Atlassian app through Signalbox MCP, search its Confluence page for ${person.pageMarker}, read issue ${person.issueKey}, then reply exactly ${nativeMarker}.`]
      : ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "apps",
        "-c", 'mcp_servers.signalbox.tools.call.approval_mode="approve"',
        "--model", nativeModelName, "--json",
        `Find the Atlassian app through Signalbox MCP, search its Confluence page for ${person.pageMarker}, read issue ${person.issueKey}, then reply exactly ${nativeMarker}.`];
    const result = await launch(cli, args, env, work, realHome);
    const saved = {
      client,
      pid: result.pid,
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      turns: fixture.trace,
      fixtureFailures: fixture.failures,
      stderrTail: result.stderr.slice(-3000).replaceAll(token, "[redacted]"),
      stdoutTail: result.stdout.slice(-3000).replaceAll(token, "[redacted]"),
    };
    await writeFile(join(home, "result.json"), JSON.stringify(saved), { mode: 0o600 });
    assert.equal(result.timedOut, false, `${client} timed out`);
    assert.equal(result.code, 0, `${client} failed; see private native result log`);
    assert.deepEqual(fixture.failures, []);
    assert.ok(fixture.complete(), `${client} did not return search, Confluence and Jira results through MCP`);
    if (client === "claude") assert.equal(JSON.parse(result.stdout).result, nativeMarker);
    else {
      const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === "item.completed" && event.item.type === "agent_message" && event.item.text === nativeMarker));
      assert.ok(events.some((event) => event.type === "item.completed" && event.item.type === "mcp_tool_call"
        && event.item.server === "signalbox" && event.item.tool === "search" && event.item.status === "completed"));
      assert.ok(events.filter((event) => event.type === "item.completed" && event.item.type === "mcp_tool_call"
        && event.item.server === "signalbox" && event.item.tool === "call" && event.item.status === "completed").length >= 2);
    }
    return { status: "passed", turns: fixture.trace.length };
  } finally {
    await fixture.stop();
  }
}

/** Run installed CLIs only. Each gets a private HOME and localhost-only network access. */
export async function proveInstalledClients({ root, directory, toolsOrigin, token, toolPaths, person, realHome }) {
  const results = {};
  for (const client of ["claude", "codex"]) {
    const cli = await binary(client);
    if (!cli) {
      results[client] = { status: "skipped", reason: "CLI not installed" };
      continue;
    }
    results[client] = await proveClient({ client, cli, root, directory, toolsOrigin, token, toolPaths, person, realHome });
  }
  return results;
}
