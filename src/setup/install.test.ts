import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "smol-toml";
import { brand } from "../../brand.ts";
import { digest } from "../pool/computer-home.ts";
import { fixture, owner, pool, signingKey } from "../pool/test/computers.ts";
import { handleRequest, type RouterEnv } from "../router.ts";

test("the installer preserves the minted tools-only bearer through both clients and the first successful tool observation", async (t) => {
  const f = fixture();
  f.advance(Date.now() - f.now());
  f.home.observed = async () => new Date(f.now()).toISOString();
  const intent = await f.intent(owner);
  const origin = "https://setup.example";
  const pending: Promise<unknown>[] = [];
  let token = "";
  const env: RouterEnv = {
    DASHBOARD_HOST: "setup.example",
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_SERVICE: {
      fetch: (request) => {
        f.advance(Date.now() - f.now());
        return f.setup(request);
      },
    },
    CATALOG_SERVICE: {
      fetch: async () => {
        throw new Error("Unexpected catalog call");
      },
    },
    TOOLS_SERVICE: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/get-session")
          return Response.json({ user: { id: owner, emailVerified: true } });
        if (path === "/api/auth/api-key/create") {
          const input = (await request.json()) as {
            metadata: { organization: string; scope?: string };
          };
          assert.equal(input.metadata.organization, pool.organization);
          token =
            input.metadata.scope === "tools" ? "ext_installer-fixture" : "exp_installer-fixture";
          return Response.json({ id: "installer-key", key: token });
        }
        if (path === "/mcp") {
          if (request.headers.get("authorization") !== `Bearer ${token}`)
            return new Response(null, { status: 401 });
          const call = (await request.json()) as { id: number; method: string };
          return Response.json({
            jsonrpc: "2.0",
            id: call.id,
            result:
              call.method === "tools/call"
                ? { content: [{ type: "text", text: "Synthetic tool result" }] }
                : { tools: [] },
          });
        }
        throw new Error(`Unexpected tools request: ${path}`);
      },
    },
  };
  const route = (path: string, init: RequestInit = {}) =>
    handleRequest(new Request(origin + path, init), env, {
      waitUntil: (work) => {
        pending.push(work);
      },
    });
  const created = await route("/setup/v1/links", {
    method: "POST",
    headers: {
      origin,
      cookie: "executor-hosted.session_token=synthetic",
      "content-type": "application/json",
    },
    body: JSON.stringify({ intent, name: "Installed computer" }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  assert.match(token, /^ext_/);
  const link = (await created.json()) as { link: string; computerId: string };
  const claimed = await route(new URL(link.link).pathname, {
    headers: { accept: "application/json" },
  });
  assert.equal(claimed.status, 200);
  const payload = await claimed.text();
  const listed = await route(`/setup/v1/computers?intent=${encodeURIComponent(intent)}`, {
    headers: { cookie: "executor-hosted.session_token=synthetic" },
  });
  assert.equal(listed.status, 200);
  const before = (await f.registry())[link.computerId]!;
  assert.ok(before.firstModelRequestAt);
  assert.equal(before.toolsHash, await digest(token));
  assert.equal(before.firstToolCallAt, null);
  assert.ok(!f.events.some(([event]) => event === "setup_completed"));

  const home = await mkdtemp(join(tmpdir(), "tools-only-installer-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, "setup.json");
  await writeFile(file, payload, { mode: 0o600 });
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
  };
  const run = promisify(execFile);
  const installer = new URL("./client.mjs", import.meta.url);
  const installed = await run(process.execPath, [installer.pathname, "--payload-file", file], {
    env: environment,
  });
  assert.doesNotMatch(installed.stdout + installed.stderr, /ext_installer-fixture/);
  const claude = JSON.parse(
    await readFile(join(environment.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8"),
  ) as { mcpServers: Record<string, { url: string; headers: { Authorization: string } }> };
  const codex = parse(await readFile(join(environment.CODEX_HOME, "config.toml"), "utf8")) as {
    mcp_servers: Record<string, { url: string; http_headers: { Authorization: string } }>;
  };
  const codexClient = codex.mcp_servers[brand.mcpServerName]!;
  const clients = [
    claude.mcpServers[brand.mcpServerName]!,
    { url: codexClient.url, headers: codexClient.http_headers },
  ];
  for (const [index, client] of clients.entries()) {
    const headers = client.headers;
    assert.equal(headers.Authorization, `Bearer ${token}`);
    assert.equal(client.url, origin + "/mcp");
    const response = await route("/mcp", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: index,
        method: index === 0 ? "tools/list" : "tools/call",
        params: { name: "synthetic" },
      }),
    });
    assert.equal(response.status, 200);
    await Promise.all(pending.splice(0));
    const current = (await f.registry())[link.computerId]!;
    if (index === 0)
      assert.equal(current.firstToolCallAt, null, "listing tools cannot complete setup");
    else assert.ok(current.firstToolCallAt, "the installed bearer must match its stored hash");
  }
  assert.equal(f.events.filter(([event]) => event === "setup_completed").length, 1);
  await run(process.execPath, [installer.pathname, "--undo"], { env: environment });
  await assert.rejects(readFile(join(environment.CLAUDE_CONFIG_DIR, ".claude.json")), {
    code: "ENOENT",
  });
});
