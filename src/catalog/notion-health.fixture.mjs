import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Effect } from "effect";
import source from "./notion.json" with { type: "json" };

let value = { id: "bot-synthetic", bot: { workspace_name: "Design workspace" } };
let mode = "structured";
let calls = [];
const opened = new Set();
const closed = new Set();
const pending = new Map();
let abortOnCall;
let hungSession;
let sequence = 0;
const peer = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push({
      path,
      method: request.method,
      authorization: request.headers.get("authorization"),
    });
    if (request.headers.get("authorization") !== "Bearer synthetic-good")
      return new Response("Unauthorized", { status: 401 });
    if (path === "/v1/users/me") return Response.json(value);
    if (request.method === "DELETE") {
      const session = request.headers.get("mcp-session-id");
      assert.ok(opened.has(session), "DELETE refers to an opened session");
      assert.ok(!closed.has(session), "session is closed only once");
      closed.add(session);
      pending.get(session)?.(Response.json({}));
      pending.delete(session);
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") return new Response(null, { status: 405 });
    const body = await request.json();
    if (body.id === undefined) return new Response(null, { status: 202 });
    const session =
      body.method === "initialize"
        ? `synthetic-session-${++sequence}`
        : request.headers.get("mcp-session-id");
    let result;
    if (body.method === "initialize") {
      opened.add(session);
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-notion", version: "1" },
      };
    } else if (body.method === "tools/list")
      result = {
        tools: [
          {
            name: "notion-get-self",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    else {
      assert.equal(body.method, "tools/call");
      assert.equal(body.params.name, "notion-get-self");
      if (mode === "hang" || mode === "abort") {
        if (mode === "hang") hungSession = session;
        return new Promise((resolve) => {
          pending.set(session, resolve);
          if (mode === "abort") abortOnCall.abort();
        });
      }
      if (mode === "failure")
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32603, message: "Synthetic naming failure" },
        });
      result =
        mode === "text" || mode === "fallback"
          ? {
              content: [{ type: "text", text: JSON.stringify(value) }],
              ...(mode === "fallback" ? { structuredContent: { unexpected: true } } : {}),
            }
          : mode === "empty"
            ? { content: [] }
            : mode === "tool-error"
              ? { isError: true, content: [] }
              : { content: [], structuredContent: value };
    }
    return Response.json(
      { jsonrpc: "2.0", id: body.id, result },
      { headers: { "mcp-session-id": session } },
    );
  },
});
const directory = await mkdtemp(resolve(".upstream/packages/apps/.notion-health-"));
try {
  for (const file of source.files.filter(
    (file) => /\.(ts|json)$/.test(file.path) && file.path !== "package.json",
  )) {
    let content = file.content
      .replaceAll("https://mcp.notion.com/mcp", `${peer.url}mcp`)
      .replaceAll("https://api.notion.com", peer.url.toString().replace(/\/$/, ""));
    if (file.path === "index.ts")
      content =
        content.slice(0, content.indexOf("export default defineApp")) + "export { notion };\n";
    await writeFile(join(directory, file.path), content);
  }
  const { notion } = await import(join(directory, "index.ts"));
  const check = (method, token = "synthetic-good", extra = {}) =>
    Effect.runPromise(
      notion.health.run({
        account: {
          id: "acc_synthetic",
          method,
          fields: method === "oauth" ? { access_token: token } : { token },
        },
        fetch: (input, init) => {
          assert.equal(new URL(input).origin, peer.url.origin);
          return fetch(input, init);
        },
        signal: new AbortController().signal,
        deadline: Date.now() + 10_000,
        ...extra,
      }),
    );
  for (const method of ["token", "oauth"]) {
    calls = [];
    for (const name of [
      "Design workspace",
      "  Design workspace  ",
      "   ",
      undefined,
      null,
      42,
      "x".repeat(300),
    ]) {
      value = { id: "bot-synthetic", bot: name === undefined ? {} : { workspace_name: name } };
      for (const representation of method === "oauth"
        ? ["structured", "text", "fallback"]
        : ["structured"]) {
        mode = representation;
        const result = await check(method);
        assert.deepEqual(result.accountInfo, {
          externalId: value.id,
          ...(typeof name === "string" && name.trim()
            ? { displayName: name.trim().slice(0, 255) }
            : {}),
        });
      }
    }
    for (const bot of [undefined, null, 42, "unexpected", []]) {
      value = { id: "bot-synthetic", ...(bot === undefined ? {} : { bot }) };
      mode = "structured";
      assert.deepEqual((await check(method)).accountInfo, { externalId: value.id });
    }
    await assert.rejects(check(method, "synthetic-rejected"));
    assert.ok(
      calls.every((call) =>
        method === "oauth" ? call.path === "/mcp" : call.path === "/v1/users/me",
      ),
    );
  }
  for (mode of ["failure", "empty", "tool-error"]) assert.deepEqual(await check("oauth"), {});
  value = { unexpected: true };
  mode = "structured";
  assert.deepEqual(await check("oauth"), {});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(check("oauth", "synthetic-good", { signal: controller.signal }));
  value = { id: "bot-synthetic", bot: { workspace_name: "Design workspace" } };
  mode = "hang";
  const start = performance.now();
  const deadline = Date.now() + 10_000;
  assert.deepEqual(await check("oauth", "synthetic-good", { deadline }), {});
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 4_900, `lookup waited for its 5-second budget: ${elapsed}`);
  assert.ok(
    hungSession !== undefined && closed.has(hungSession) && !pending.has(hungSession),
    "the check ended the hanging lookup itself and closed its session",
  );
  assert.ok(Date.now() < deadline, "lookup timed out before the account check deadline");
  mode = "abort";
  abortOnCall = new AbortController();
  await assert.rejects(check("oauth", "synthetic-good", { signal: abortOnCall.signal }));
  const { readMcpSelf } = await import(join(directory, "health.ts"));
  assert.equal(
    await readMcpSelf(
      {
        signal: new AbortController().signal,
        deadline: Date.now(),
        fetch: () => {
          throw new Error("Expired budget must not fetch");
        },
      },
      `${peer.url}mcp`,
      {},
    ),
    undefined,
  );
  const during = new AbortController();
  await assert.rejects(
    readMcpSelf(
      {
        signal: during.signal,
        fetch: async () => {
          during.abort();
          throw during.signal.reason;
        },
      },
      `${peer.url}mcp`,
      {},
    ),
  );
  assert.ok(opened.size > 0, "fixture opened MCP sessions");
  assert.deepEqual(
    [...closed].sort(),
    [...opened].sort(),
    "every opened MCP session is terminated, including timed out and aborted lookups",
  );
  assert.equal(pending.size, 0, "no hanging calls remain after cleanup");
  console.log(
    `Notion synthetic REST and MCP health checks passed; ${opened.size} sessions opened and closed`,
  );
} finally {
  peer.stop(true);
  await rm(directory, { recursive: true, force: true });
}
