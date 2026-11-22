import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Effect } from "effect";
import source from "../../src/catalog/notion.json" with { type: "json" };

// REST `users/me` answers with the integration's bot user; MCP `notion-get-self` answers with the
// connected workspace and person, as Notion documents it ("Build an MCP client").
let rest = { id: "bot-synthetic", bot: { workspace_name: "Design workspace" } };
const person = { type: "person", id: "user-synthetic", name: "Ada", email: "ada@example.test" };
let self = { workspace: { id: "ws-synthetic", name: "Design workspace" }, user: person };
let mode = "structured";
let serverVersion = "2025-03-26";
let calls = [];
const opened = new Set();
const closed = new Set();
const held = new Map();
const pending = new Map();
let abortOnCall;
let hungSession;
let sequence = 0;
const peer = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const call = {
      path,
      method: request.method,
      authorization: request.headers.get("authorization"),
      version: request.headers.get("mcp-protocol-version"),
    };
    calls.push(call);
    if (request.headers.get("authorization") !== "Bearer synthetic-good")
      return new Response("Unauthorized", { status: 401 });
    if (path === "/v1/users/me") return Response.json(rest);
    if (request.method === "DELETE") {
      const session = request.headers.get("mcp-session-id");
      assert.ok(opened.has(session), "DELETE refers to an opened session");
      assert.ok(!closed.has(session), "session is closed only once");
      closed.add(session);
      for (const close of held.get(session) ?? []) close();
      held.delete(session);
      pending.get(session)?.(Response.json({}));
      pending.delete(session);
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") return new Response(null, { status: 405 });
    const body = await request.json();
    call.rpc = body.method;
    if (body.id === undefined)
      return new Response(null, { status: mode === "notify-rejected" ? 400 : 202 });
    const session =
      body.method === "initialize"
        ? `synthetic-session-${++sequence}`
        : request.headers.get("mcp-session-id");
    let result;
    if (body.method === "initialize") {
      opened.add(session);
      result = {
        ...(serverVersion === undefined ? {} : { protocolVersion: serverVersion }),
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
              content: [{ type: "text", text: JSON.stringify(self) }],
              ...(mode === "fallback" ? { structuredContent: { unexpected: true } } : {}),
            }
          : mode === "empty"
            ? { content: [] }
            : mode === "tool-error"
              ? { isError: true, content: [] }
              : { content: [], structuredContent: self };
    }
    const message = { jsonrpc: "2.0", id: body.id, result };
    // Streamable HTTP servers may answer a request as a server-sent event stream instead of JSON.
    // A server may keep a call's stream open after answering; the answer must still arrive.
    if (mode === "held" && body.method === "tools/call") {
      const encoder = new TextEncoder();
      // Split between JSON tokens: a client joins the data lines with a newline.
      const text = JSON.stringify(message);
      const [head, tail] = [
        text.slice(0, text.indexOf(",") + 1),
        text.slice(text.indexOf(",") + 1),
      ];
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            controller.enqueue(
              encoder.encode(
                `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode(`event: message\ndata: ${head}\ndata: ${tail}\n\n`));
            held.set(session, [
              ...(held.get(session) ?? []),
              () => {
                // The client may already have cancelled the stream after reading its answer.
                try {
                  controller.close();
                } catch {}
              },
            ]);
          },
        }),
        { headers: { "content-type": "text/event-stream", "mcp-session-id": session } },
      );
    }
    // A server request may reuse the id of the request it interrupts; it is never the answer.
    if (mode === "server-request")
      return new Response(
        [{ jsonrpc: "2.0", id: body.id, method: "ping" }, message]
          .map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream", "mcp-session-id": session } },
      );
    if (mode === "batch")
      return Response.json([{ jsonrpc: "2.0", id: body.id + 100, result: {} }, message], {
        headers: { "mcp-session-id": session },
      });
    if (mode === "stream")
      return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
        headers: { "content-type": "text/event-stream", "mcp-session-id": session },
      });
    return Response.json(message, { headers: { "mcp-session-id": session } });
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
  const names = [
    "Design workspace",
    "  Design workspace  ",
    "   ",
    "",
    undefined,
    null,
    42,
    "x".repeat(300),
  ];
  const named = (name) =>
    typeof name === "string" && name.trim()
      ? { displayName: name.trim().slice(0, 255) }
      : undefined;
  calls = [];
  for (const name of names) {
    rest = { id: "bot-synthetic", bot: name === undefined ? {} : { workspace_name: name } };
    mode = "structured";
    assert.deepEqual((await check("token")).accountInfo, {
      externalId: rest.id,
      ...named(name),
    });
  }
  for (const bot of [undefined, null, 42, "unexpected", []]) {
    rest = { id: "bot-synthetic", ...(bot === undefined ? {} : { bot }) };
    assert.deepEqual((await check("token")).accountInfo, { externalId: rest.id });
  }
  await assert.rejects(check("token", "synthetic-rejected"));
  assert.ok(calls.every((call) => call.path === "/v1/users/me"));
  calls = [];
  for (const name of names)
    for (const user of [person, { type: "bot", id: "bot-user" }]) {
      self = {
        workspace: name === undefined ? { id: "ws-synthetic" } : { id: "ws-synthetic", name },
        user,
      };
      for (mode of ["structured", "text", "fallback", "stream", "held"])
        assert.deepEqual(
          (await check("oauth")).accountInfo,
          {
            externalId: user.id,
            // A workspace without a name falls back to the person's email, never to an id.
            ...(named(name) ?? (user.email === undefined ? {} : { email: user.email })),
          },
          `${mode} ${JSON.stringify(self)}`,
        );
    }
  for (const workspace of [undefined, null, 42, "unexpected", []]) {
    self = { ...(workspace === undefined ? {} : { workspace }), user: person };
    mode = "text";
    assert.deepEqual((await check("oauth")).accountInfo, {
      externalId: person.id,
      email: person.email,
    });
  }
  // A cut email would name someone else, so one past the host's 255 characters is left out.
  self = {
    workspace: { id: "ws-synthetic", name: "" },
    user: { ...person, email: `${"x".repeat(250)}@example.test` },
  };
  assert.deepEqual((await check("oauth")).accountInfo, { externalId: person.id });
  // An id the host would reject is left out rather than failing the verified account.
  for (const user of [
    { ...person, id: "" },
    { ...person, id: "u".repeat(256) },
  ]) {
    self = { workspace: { id: "ws-synthetic", name: "Design workspace" }, user };
    assert.deepEqual((await check("oauth")).accountInfo, { displayName: "Design workspace" });
  }
  // The REST shape is not what the MCP tool answers; it names nothing there.
  self = { id: "bot-synthetic", bot: { workspace_name: "Design workspace" } };
  assert.deepEqual(await check("oauth"), {});
  await assert.rejects(check("oauth", "synthetic-rejected"));
  assert.ok(calls.every((call) => call.path === "/mcp"));
  for (mode of ["failure", "empty", "tool-error"]) assert.deepEqual(await check("oauth"), {});
  self = { unexpected: true };
  mode = "structured";
  assert.deepEqual(await check("oauth"), {});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(check("oauth", "synthetic-good", { signal: controller.signal }));
  self = { workspace: { id: "ws-synthetic", name: "Design workspace" }, user: person };
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
  // Where the MCP client library ends a lookup or reads past a message, the plain lookup does too.
  self = { workspace: { id: "ws-synthetic", name: "Design workspace" }, user: person };
  const lookup = () =>
    readMcpSelf(
      { signal: new AbortController().signal, deadline: Date.now() + 10_000, fetch },
      `${peer.url}mcp`,
      { Authorization: "Bearer synthetic-good" },
    );
  const strictness = {};
  for (const [name, setup] of [
    ["server request reusing the lookup id", () => (mode = "server-request")],
    ["batched JSON answer", () => (mode = "batch")],
    ["rejected initialized notification", () => (mode = "notify-rejected")],
    ["unsupported protocol version", () => (serverVersion = "1999-01-01")],
    ["no protocol version", () => (serverVersion = undefined)],
  ]) {
    mode = "structured";
    serverVersion = "2025-03-26";
    setup();
    calls = [];
    const info = await lookup();
    // The requests show where the lookup ended and which version closed its session.
    strictness[name] = [info, calls.map((call) => call.rpc ?? `${call.method} ${call.version}`)];
  }
  mode = "structured";
  const workspace = { externalId: person.id, displayName: "Design workspace" };
  const answered = ["initialize", "notifications/initialized", "tools/call", "DELETE 2025-03-26"];
  assert.deepEqual(strictness, {
    "server request reusing the lookup id": [workspace, answered],
    "batched JSON answer": [workspace, answered],
    "rejected initialized notification": [
      undefined,
      ["initialize", "notifications/initialized", "DELETE 2025-03-26"],
    ],
    // A server that declined the requested version would refuse to close under it.
    "unsupported protocol version": [undefined, ["initialize", "DELETE 1999-01-01"]],
    "no protocol version": [undefined, ["initialize", "DELETE 2025-03-26"]],
  });
  // Another version the library accepts still names the account, and later requests carry it.
  serverVersion = "2025-06-18";
  calls = [];
  assert.deepEqual(await lookup(), workspace);
  assert.deepEqual([...new Set(calls.slice(1).map((call) => call.version))], ["2025-06-18"]);
  serverVersion = "2025-03-26";
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
