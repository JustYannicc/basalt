import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { launch, command } from "./support.ts";
import { fixture, ready } from "./native-client-fixture.ts";

test(
  "native CLI signs in, renews once, streams models and tools, and preserves its local profile across restart",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      f.remote.expireNext(1);
      await f.login();
      f.remote.expireNext(3600);
      await command(["agent", "add", "both", "models", "tools"], f.home);
      let origin = await f.start();
      const firstOrigin = origin;
      const token = await f.token(),
        headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      assert.equal(f.remote.counts().refreshes, 1);
      const saved = JSON.parse(await readFile(join(f.home, "credentials.json"), "utf8"));
      assert.equal(
        saved.refreshToken,
        "synthetic-refresh-2",
        "Rotated credentials must be durable before use.",
      );
      const stream = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "synthetic-model", stream: true }),
      });
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /data: first/u);
      f.remote.complete();
      let last = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        last += new TextDecoder().decode(next.value);
      }
      assert.match(last, /data: complete/u);
      const tools = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      });
      assert.equal(tools.headers.get("mcp-session-id"), "fixture-session");
      assert.match(await tools.text(), /synthetic-tool-receipt/u);
      assert.equal(f.remote.counts().writes, 1);
      const duplicateLogin = await launch(
        ["login", f.remote.origin, "--storage", "file", "--no-browser"],
        f.home,
      ).exited;
      assert.equal(duplicateLogin.code, 1, "An active process owns refresh and credential writes.");
      await f.stop();
      origin = await f.start();
      assert.equal(origin, firstOrigin);
      assert.equal(await f.token(), token);
      assert.equal(JSON.parse((await command(["status"], f.home)).stdout).mode, "device");
      assert.equal(f.remote.counts().refreshes, 1);
      await command(["revoke"], f.home);
      assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "revoked");
      await assert.rejects(readFile(join(f.home, "credentials.json")));
      const refused = await fetch(`${origin}/v1/models`, { headers });
      assert.equal(refused.status, 503);
      await refused.body?.cancel();
      assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "revoked");
    } finally {
      await f.close();
    }
  },
);

test(
  "native Responses sockets preserve text, binary and empty messages",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await f.login();
      await command(["agent", "add", "both", "models", "tools"], f.home);
      const origin = await f.start(),
        token = await f.token();
      const socket = new WebSocket(origin.replace("http:", "ws:") + "/v1/responses", {
        headers: { authorization: `Bearer ${token}` },
      });
      try {
        await once(socket, "open");
        for (const [bytes, binary] of [
          [Buffer.from("hello"), false],
          [Buffer.alloc(50000, 137), true],
          [Buffer.alloc(0), false],
          [Buffer.alloc(0), true],
        ] as const) {
          const message = once(socket, "message");
          socket.send(bytes, { binary });
          const [echoed, isBinary] = await message;
          assert.equal(isBinary, binary);
          assert.deepEqual(echoed, bytes);
        }
        const closed = once(socket, "close");
        await command(["disconnect"], f.home);
        await closed;
        assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "disconnected");
        const refused = await fetch(`${origin}/v1/models`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(refused.status, 503);
        await refused.body?.cancel();
        assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "disconnected");
        await command(["reconnect"], f.home);
        assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "connected");
      } finally {
        socket.terminate();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "an interrupted native tool write is uncertain and is never replayed",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await f.login();
      await command(["agent", "add", "both", "models", "tools"], f.home);
      const origin = await f.start(),
        token = await f.token();
      f.remote.dropTool(true);
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      });
      assert.equal(response.status, 502);
      assert.match(await response.text(), /outcome may be unknown.*not replayed/u);
      assert.equal(f.remote.counts().writes, 1);
      await f.stop();
      await f.start();
      assert.equal(f.remote.counts().writes, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "a lost refresh result remains blocked after restart without another exchange",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      f.remote.expireNext(1);
      await f.login();
      f.remote.loseRefresh();
      await command(["agent", "add", "both", "models", "tools"], f.home);
      await f.start();
      assert.equal(f.remote.counts().refreshes, 1);
      assert.equal(
        JSON.parse((await command(["status"], f.home)).stdout).state,
        "sign-in-required",
      );
      assert.equal(
        JSON.parse(await readFile(join(f.home, "credentials.json"), "utf8")).refreshPending,
        true,
      );
      await f.stop();
      await f.start();
      assert.equal(f.remote.counts().refreshes, 1);
      assert.equal(
        JSON.parse((await command(["status"], f.home)).stdout).state,
        "sign-in-required",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "denied sign-in and a foreign approval URL preserve an existing direct profile",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      const input = join(f.home, "direct.json");
      await writeFile(
        input,
        JSON.stringify({
          version: 1,
          mode: "direct",
          models: { origin: f.remote.origin, token: "existing-synthetic-model-key" },
        }),
        { mode: 0o600 },
      );
      await command(["import-direct", input, "--storage", "file"], f.home);
      const before = await readFile(join(f.home, "credentials.json"), "utf8");
      f.remote.deny();
      const denied = launch(
        ["login", f.remote.origin, "--storage", "file", "--no-browser"],
        f.home,
      );
      await ready(denied, /Confirmation code:/u);
      const deniedResult = await denied.exited;
      assert.equal(deniedResult.code, 1);
      assert.match(deniedResult.stderr, /Device sign-in was denied/u);
      assert.equal(await readFile(join(f.home, "credentials.json"), "utf8"), before);
      f.remote.foreignApproval();
      const foreign = await launch(
        ["login", f.remote.origin, "--storage", "file", "--no-browser"],
        f.home,
      ).exited;
      assert.equal(foreign.code, 1);
      assert.ok(
        !foreign.stderr.includes("foreign.example.test"),
        "A foreign approval URL is refused before display or browser launch.",
      );
      assert.equal(await readFile(join(f.home, "credentials.json"), "utf8"), before);
      assert.equal(f.remote.counts().polls, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "a native refusal preserves its status and body while a large request is still uploading",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await f.login();
      await command(["agent", "add", "both", "models", "tools"], f.home);
      const origin = await f.start(),
        token = await f.token();
      f.remote.refuseRequest();
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "x".repeat(1024 * 1024) }),
      });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "7");
      assert.deepEqual(await response.json(), { error: "synthetic-limit" });
    } finally {
      await f.close();
    }
  },
);

test("device model failures retain non-retryable ambiguity and explicit not-started refusal", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.login();
    await command(["agent", "add", "both", "models"], f.home);
    const origin = await f.start(), token = await f.token();
    for (const mode of ["not-started", "unknown", "disconnect"] as const) {
      f.remote.failModel(mode);
      const before = f.remote.counts().modelSends;
      const response = await fetch(`${origin}/v1/responses`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "synthetic-model" }),
      });
      if (mode === "not-started") {
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("x-should-retry"), null);
        assert.equal(f.remote.counts().modelSends, before);
        await response.body?.cancel();
      } else {
        assert.equal(response.status, 502);
        assert.equal(response.headers.get("x-should-retry"), "false");
        assert.equal(response.headers.get("retry-after"), null);
        assert.equal(response.headers.get("retry-after-ms"), null);
        const body = await response.json() as { error: { code: string; retryable: boolean } };
        assert.equal(body.error.code, "upstream_outcome_unknown");
        assert.equal(body.error.retryable, false);
        assert.equal(f.remote.counts().modelSends, before + 1);
      }
    }
  } finally { await f.close(); }
});


for (const mode of ["close", "timeout"] as const) test(`device model ${mode} before ready stays retryable without sending an operation`, { timeout: 45000 }, async () => {
  const f = await fixture();
  try {
    await f.login();
    await command(["agent", "add", "both", "models"], f.home);
    const origin = await f.start(), token = await f.token();
    f.remote.failBeforeReady(mode);
    const before = f.remote.counts();
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "synthetic-model" }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-should-retry"), null);
    assert.deepEqual(await response.json(), { error: "Model access is unavailable." });
    assert.equal(f.remote.counts().operationOpens, before.operationOpens);
    assert.equal(f.remote.counts().modelSends, before.modelSends);
  } finally { await f.close(); }
});
