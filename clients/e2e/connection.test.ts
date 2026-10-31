import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { networkInterfaces, tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { command, fixtureHome, independentAgent, launch, main, rawStatus } from "./support.ts";
import { remoteFixture } from "./remote-fixture.ts";

let remote: Awaited<ReturnType<typeof remoteFixture>>;
let profile: Awaited<ReturnType<typeof fixtureHome>>;
let runtime: Awaited<ReturnType<Awaited<ReturnType<typeof fixtureHome>>["start"]>>;
let both: string, models: string, tools: string;
before(async () => {
  assert.equal(
    process.platform,
    "linux",
    "This suite proves the explicit headless Linux file-storage path.",
  );
  remote = await remoteFixture();
  profile = await fixtureHome(remote.origin);
  [both, models, tools] = await Promise.all([
    profile.secret("both"),
    profile.secret("models"),
    profile.secret("tools"),
  ]);
  runtime = await profile.start();
});
after(async () => {
  const results = await Promise.allSettled([runtime?.stop(), remote?.close()]);
  await profile?.remove();
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
const headers = (token = both) => ({ authorization: `Bearer ${token}` });

test("a missing OS credential store refuses without a plaintext fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "signalbox-client-no-store-"));
  try {
    const input = join(home, "input.json");
    await writeFile(
      input,
      JSON.stringify({
        version: 1,
        mode: "direct",
        models: { origin: remote.origin, token: "synthetic-model-key" },
      }),
      { mode: 0o600 },
    );
    const result = await launch(["import-direct", input], home).exited;
    assert.equal(result.code, 1, "This headless runner has no unlocked desktop credential store.");
    await assert.rejects(readFile(join(home, "credentials.json")));
    await assert.rejects(readFile(join(home, "profile.json")));
    assert.ok(
      !result.stdout.includes("synthetic-model-key") &&
        !result.stderr.includes("synthetic-model-key"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test(
  "independent agent receives the first chunk before upstream completion",
  { timeout: 10_000 },
  async () => {
    const agent = independentAgent(
      `
    const response = await fetch(process.env.LOCAL_ORIGIN + "/v1/responses", {
      method: "POST", headers: { authorization: "Bearer " + process.env.LOCAL_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ mode: "stream", stream: true }) });
    const reader = response.body.getReader();
    const first = await reader.read();
    process.send({ first: new TextDecoder().decode(first.value) });
    let text = "";
    for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
    process.send({ rest: text }); process.disconnect();
  `,
      runtime.origin,
      both,
    );
    const first = await agent.message();
    assert.deepEqual(first, { first: "data: first\n\n" });
    const finished = agent.message();
    remote.finishStream.resolve();
    assert.deepEqual(await finished, { rest: "data: done\n\n" });
    assert.equal((await agent.exited).code, 0);
  },
);

test("reader cancellation closes the remote stream", { timeout: 10_000 }, async () => {
  const agent = independentAgent(
    `
    const response = await fetch(process.env.LOCAL_ORIGIN + "/v1/responses", { method: "POST",
      headers: { authorization: "Bearer " + process.env.LOCAL_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ mode: "cancel" }) });
    const reader = response.body.getReader(); await reader.read(); await reader.cancel(); process.disconnect();
  `,
    runtime.origin,
    both,
  );
  await remote.cancelled.promise;
  assert.equal((await agent.exited).code, 0);
});

test(
  "paused independent reader applies backpressure while other calls remain usable",
  { timeout: 15_000 },
  async () => {
    const agent = independentAgent(
      `
    import { once } from "node:events";
    const response = await fetch(process.env.LOCAL_ORIGIN + "/v1/responses", { method: "POST",
      headers: { authorization: "Bearer " + process.env.LOCAL_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ mode: "slow" }) });
    const reader = response.body.getReader(); let bytes = (await reader.read()).value.length;
    process.send({ paused: true }); await once(process, "message");
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; }
    process.send({ bytes }); process.disconnect();
  `,
      runtime.origin,
      both,
    );
    assert.deepEqual(await agent.message(), { paused: true });
    const response = await fetch(`${runtime.origin}/v1/models`, { headers: headers() });
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.ok(
      remote.slowBytes() < remote.slowTotal,
      "The paused reader must prevent upstream from finishing its body.",
    );
    const completed = agent.message();
    agent.child.send("read");
    assert.deepEqual(await completed, {
      bytes: remote.slowTotal + Buffer.byteLength("data: first\n\n"),
    });
    assert.equal((await agent.exited).code, 0);
  },
);

test("Host, Origin, forwarded identity, credentials and per-agent service scope refuse", async () => {
  const cases: ReadonlyArray<Record<string, string>> = [
    { host: "attacker.example" },
    { origin: "https://attacker.example" },
    { forwarded: "for=127.0.0.1" },
    { "x-forwarded-host": "localhost" },
  ];
  for (const extra of cases) {
    assert.equal(
      await rawStatus(`${runtime.origin}/v1/models`, { ...headers(), ...extra }),
      403,
      `Refuse supplied header ${Object.keys(extra)[0]}`,
    );
  }
  for (const [path, token, status] of [
    ["/v1/models", "wrong-credential", 401],
    ["/v1/models", tools, 401],
    ["/mcp", models, 401],
    ["/api/organizations", both, 404],
  ]) {
    const response = await fetch(`${runtime.origin}${path}`, { headers: headers(String(token)) });
    assert.equal(response.status, status);
    await response.body?.cancel();
  }
  const network = Object.values(networkInterfaces())
    .flat()
    .find((value) => value && value.family === "IPv4" && !value.internal);
  assert.ok(network, "The Linux test host must have a non-loopback interface.");
  await assert.rejects(
    fetch(`http://${network.address}:${new URL(runtime.origin).port}/v1/models`, {
      headers: headers(),
      signal: AbortSignal.timeout(1000),
    }),
  );
});

test("remote errors propagate without changing their status, body or retry hint", async () => {
  const response = await fetch(`${runtime.origin}/v1/responses`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ mode: "error" }),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "17");
  assert.deepEqual(await response.json(), { error: "synthetic quota refusal" });
});

test(
  "model WebSocket upgrades forward opaque frames through the authenticated gateway",
  { timeout: 10_000 },
  async () => {
    const outgoing = request(`${runtime.origin}/v1/responses`, {
      headers: {
        ...headers(models),
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    const upgraded = once(outgoing, "upgrade");
    outgoing.end();
    const [response, socket] = await upgraded;
    assert.equal(response.statusCode, 101);
    const frame = Buffer.from([
      0x81,
      0x85,
      0x11,
      0x22,
      0x33,
      0x44,
      ...[...Buffer.from("hello")].map(
        (byte, index) => byte ^ [0x11, 0x22, 0x33, 0x44][index % 4]!,
      ),
    ]);
    const received = once(socket, "data");
    socket.write(frame);
    assert.deepEqual(await remote.websocketBytes.promise, frame);
    assert.deepEqual((await received)[0], Buffer.from([0x81, 5, ...Buffer.from("hello")]));
    socket.destroy();
  },
);

test(
  "official MCP clients call the same gateway over HTTP and private stdio IPC",
  { timeout: 15_000 },
  async () => {
    const http = new Client({ name: "independent-http", version: "1.0.0" });
    const stdio = new Client({ name: "independent-stdio", version: "1.0.0" });
    try {
      await http.connect(
        new StreamableHTTPClientTransport(new URL(`${runtime.origin}/mcp`), {
          requestInit: { headers: headers(tools) },
        }),
      );
      assert.equal((await http.listTools()).tools[0]?.name, "echo");
      assert.deepEqual(
        (await http.callTool({ name: "echo", arguments: { transport: "http" } })).content,
        [{ type: "text", text: '{"transport":"http"}' }],
      );
      await stdio.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [main, "--home", profile.home, "stdio", "--agent", "tools"],
          stderr: "pipe",
        }),
      );
      assert.equal((await stdio.listTools()).tools[0]?.name, "echo");
      assert.deepEqual(
        (await stdio.callTool({ name: "echo", arguments: { transport: "stdio" } })).content,
        [{ type: "text", text: '{"transport":"stdio"}' }],
      );
      assert.equal(remote.calls(), 2);
    } finally {
      await Promise.allSettled([http.close(), stdio.close()]);
    }
  },
);

test(
  "disconnect, restart and local-agent removal preserve settings and refuse access",
  { timeout: 15_000 },
  async () => {
    const previous = runtime.origin;
    await command(["disconnect"], profile.home);
    let response = await fetch(`${runtime.origin}/v1/models`, { headers: headers() });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-should-retry"), null);
    await response.body?.cancel();
    await command(["reconnect"], profile.home);
    await runtime.stop();
    runtime = await profile.start();
    assert.equal(runtime.origin, previous);
    response = await fetch(`${runtime.origin}/v1/models`, { headers: headers() });
    assert.equal(response.status, 200);
    await response.body?.cancel();
    await command(["agent", "remove", "models"], profile.home);
    response = await fetch(`${runtime.origin}/v1/models`, { headers: headers(models) });
    assert.equal(response.status, 401);
    await response.body?.cancel();
    const result = await command(["status"], profile.home);
    assert.deepEqual(JSON.parse(result.stdout), {
      state: "connected",
      mode: "direct",
      capabilities: ["models", "tools"],
    });
    const saved = await readFile(join(profile.home, "profile.json"), "utf8");
    assert.ok(!saved.includes("synthetic-model-key") && !saved.includes("ext_synthetic-tools-key"));
  },
);

test(
  "duplicate process, unsafe files, unscoped tools keys and sign-out refuse",
  { timeout: 15_000 },
  async () => {
    assert.equal((await launch(["run"], profile.home).exited).code, 1);
    const input = join(profile.home, "invalid.json");
    await writeFile(
      input,
      JSON.stringify({
        version: 1,
        mode: "direct",
        tools: { origin: remote.origin, path: "/mcp", token: "exp_unscoped" },
      }),
      { mode: 0o600 },
    );
    assert.equal(
      (await launch(["import-direct", input, "--storage", "file"], profile.home).exited).code,
      1,
    );
    const profileFile = join(profile.home, "profile.json");
    await chmod(profileFile, 0o644);
    const denied = await fetch(`${runtime.origin}/v1/models`, { headers: headers() });
    assert.equal(denied.status, 503);
    await denied.body?.cancel();
    await chmod(profileFile, 0o600);
    await command(["sign-out"], profile.home);
    const response = await fetch(`${runtime.origin}/v1/models`, { headers: headers() });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-should-retry"), null);
    await response.body?.cancel();
    assert.equal(
      JSON.parse((await command(["status"], profile.home)).stdout).state,
      "sign-in-required",
    );
    await assert.rejects(readFile(join(profile.home, "credentials.json")));
  },
);
