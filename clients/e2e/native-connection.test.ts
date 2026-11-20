import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { launch, command, main } from "./support.ts";
import { ConnectionSupervisor } from "../desktop/supervisor.ts";
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
      assert.equal(refused.status, 401);
      assert.equal(refused.headers.get("retry-after"), null);
      assert.equal(refused.headers.get("x-should-retry"), null);
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
  "CLI and desktop replay the same lost refresh pair after restart",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      f.remote.expireNext(1);
      await f.login();
      f.remote.expireNext(3600);
      f.remote.loseRefresh();
      await command(["agent", "add", "both", "models", "tools"], f.home);
      await f.start();
      assert.equal(f.remote.counts().refreshes, 1);
      assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "connected");
      const pending = JSON.parse(await readFile(join(f.home, "credentials.json"), "utf8"));
      assert.equal(pending.refreshPending, true);
      assert.equal(pending.refreshToken, "synthetic-refresh-1");
      assert.ok(Date.now() - pending.refreshStartedAt < 600_000);
      await f.stop();
      const origin = await f.start();
      assert.equal(f.remote.counts().refreshes, 2);
      assert.deepEqual(f.remote.refreshTokens(), ["synthetic-refresh-1", "synthetic-refresh-1"]);
      assert.equal(f.remote.counts().rotations, 1, "Restart replays instead of rotating again.");
      const saved = JSON.parse(await readFile(join(f.home, "credentials.json"), "utf8"));
      assert.equal(saved.accessToken, "synthetic-access-2");
      assert.equal(saved.refreshToken, "synthetic-refresh-2");
      assert.equal(saved.refreshPending, false);
      assert.equal(saved.refreshStartedAt, undefined);
      const desktop = new ConnectionSupervisor(f.home, main, process.execPath);
      await desktop.start();
      assert.equal((await desktop.status()).state, "connected");
      f.remote.inventory(200, {
        apps: [{ id: "fixture", name: "Fixture" }],
        links: [],
        appLinks: [],
      });
      assert.equal((await desktop.apps())?.apps[0]?.id, "fixture");
      await desktop.stop();
      assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "connected");
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${await f.token()}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /synthetic-tool-receipt/u);
      assert.equal(f.remote.counts().refreshes, 2);
      await f.stop();
      await f.start();
      assert.equal(
        f.remote.counts().refreshes,
        2,
        "A saved replay result needs no further exchange.",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "a definitive refresh refusal after restart requires sign-in without replaying agent work",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      f.remote.expireNext(1);
      await f.login();
      f.remote.loseRefresh();
      await command(["agent", "add", "both", "models", "tools"], f.home);
      await f.start();
      await f.stop();
      const file = join(f.home, "credentials.json");
      assert.equal(JSON.parse(await readFile(file, "utf8")).refreshPending, true);
      f.remote.refuseRefresh();
      const origin = await f.start();
      assert.equal(
        JSON.parse((await command(["status"], f.home)).stdout).state,
        "sign-in-required",
      );
      assert.equal(f.remote.counts().refreshes, 2);
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await f.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      });
      assert.equal(response.status, 401);
      await response.body?.cancel();
      assert.equal(f.remote.counts().refreshes, 2);
      assert.equal(f.remote.counts().writes, 0);
      assert.equal(JSON.parse(await readFile(file, "utf8")).refreshToken, "synthetic-refresh-1");
    } finally {
      await f.close();
    }
  },
);

/** Sleep ages a cut-off refresh while its process sees no time pass; this ages the saved start. */
async function agePendingRefresh(home: string, milliseconds: number) {
  const file = join(home, "credentials.json");
  const pending = JSON.parse(await readFile(file, "utf8"));
  assert.equal(pending.refreshPending, true);
  pending.refreshStartedAt = Date.now() - milliseconds;
  await writeFile(file, JSON.stringify(pending), { mode: 0o600 });
  return file;
}
const toolCall = (origin: string, token: string) =>
  fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
  });
const upgradeStatus = (origin: string, token: string) =>
  new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(origin.replace("http:", "ws:") + "/v1/responses", {
      headers: { authorization: `Bearer ${token}` },
    });
    socket.on("error", () => undefined);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("A device that needs sign-in admitted a WebSocket."));
    });
    socket.once("close", () => reject(new Error("The WebSocket closed without an answer.")));
  });

for (const path of ["restart", "Reconnect"] as const) {
  test(
    `a refresh that never reached the server is sent once after more than an hour and connects on ${path}`,
    { timeout: 30000 },
    async () => {
      const f = await fixture();
      try {
        f.remote.expireNext(1);
        await f.login();
        f.remote.expireNext(3600);
        await command(["agent", "add", "both", "models", "tools"], f.home);
        f.remote.offline(true);
        let origin = await f.start();
        if (path === "restart") await f.stop();
        const file = await agePendingRefresh(f.home, 3_600_001);
        f.remote.offline(false);
        if (path === "restart") origin = await f.start();
        else assert.equal((await launch(["reconnect"], f.home).exited).code, 0);
        assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "connected");
        assert.deepEqual(f.remote.refreshTokens(), ["synthetic-refresh-1"]);
        const saved = JSON.parse(await readFile(file, "utf8"));
        assert.equal(saved.refreshToken, "synthetic-refresh-2");
        assert.equal(saved.refreshPending, false);
        const response = await toolCall(origin, await f.token());
        assert.equal(response.status, 200);
        assert.match(await response.text(), /synthetic-tool-receipt/u);
        assert.equal(f.remote.counts().refreshes, 1, "One send, no retry.");
      } finally {
        await f.close();
      }
    },
  );
  test(
    `a refresh the server refuses after more than an hour asks for sign-in after one send on ${path}`,
    { timeout: 30000 },
    async () => {
      const f = await fixture();
      try {
        f.remote.expireNext(1);
        await f.login();
        f.remote.loseRefresh();
        await command(["agent", "add", "both", "models", "tools"], f.home);
        let origin = await f.start();
        if (path === "restart") await f.stop();
        const file = await agePendingRefresh(f.home, 3_600_001);
        // The server's replay window has passed, so it refuses the rotated token as reuse.
        f.remote.refuseRefresh();
        if (path === "restart") origin = await f.start();
        else assert.equal((await launch(["reconnect"], f.home).exited).code, 1);
        const token = await f.token();
        const signInRequired = async () => {
          assert.equal(
            JSON.parse((await command(["status"], f.home)).stdout).state,
            "sign-in-required",
          );
          for (const response of [
            await toolCall(origin, token),
            await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${token}` } }),
          ]) {
            assert.equal(response.status, 401);
            assert.equal(response.headers.get("retry-after"), null);
            assert.match(await response.text(), /Sign in again/u);
          }
          assert.equal(await upgradeStatus(origin, token), 401);
        };
        await signInRequired();
        assert.equal((await launch(["reconnect"], f.home).exited).code, 1);
        await signInRequired();
        assert.equal(
          f.remote.counts().refreshes,
          2,
          "The lost refresh, then one send after the window; none after the refusal.",
        );
        assert.equal(f.remote.counts().writes, 0);
        assert.equal(JSON.parse(await readFile(file, "utf8")).refreshToken, "synthetic-refresh-1");
      } finally {
        await f.close();
      }
    },
  );
  test(
    `a refresh cut off for longer than ten minutes replays inside the server's window on ${path}`,
    { timeout: 30000 },
    async () => {
      const f = await fixture();
      try {
        f.remote.expireNext(1);
        await f.login();
        f.remote.expireNext(3600);
        f.remote.loseRefresh();
        await command(["agent", "add", "both", "models", "tools"], f.home);
        let origin = await f.start();
        if (path === "restart") await f.stop();
        const file = await agePendingRefresh(f.home, 3_300_000);
        if (path === "restart") origin = await f.start();
        else assert.equal((await launch(["reconnect"], f.home).exited).code, 0);
        assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "connected");
        assert.deepEqual(f.remote.refreshTokens(), ["synthetic-refresh-1", "synthetic-refresh-1"]);
        assert.equal(
          f.remote.counts().rotations,
          1,
          "The server answers the replay with the pair it already issued.",
        );
        const saved = JSON.parse(await readFile(file, "utf8"));
        assert.equal(saved.refreshToken, "synthetic-refresh-2");
        assert.equal(saved.refreshPending, false);
        const response = await toolCall(origin, await f.token());
        assert.equal(response.status, 200);
        assert.match(await response.text(), /synthetic-tool-receipt/u);
        assert.equal(f.remote.counts().writes, 1);
      } finally {
        await f.close();
      }
    },
  );
}

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

test(
  "device model failures ask the client to retry and never replay, and refuse explicitly before start",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await f.login();
      await command(["agent", "add", "both", "models"], f.home);
      const origin = await f.start(),
        token = await f.token();
      for (const mode of ["not-started", "unknown", "disconnect"] as const) {
        f.remote.failModel(mode);
        const before = f.remote.counts().modelSends;
        const response = await fetch(`${origin}/v1/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "synthetic-model" }),
        });
        if (mode === "not-started") {
          assert.equal(response.status, 503);
          assert.equal(response.headers.get("x-should-retry"), null);
          assert.equal(f.remote.counts().modelSends, before);
          await response.body?.cancel();
        } else {
          assert.equal(response.status, 502);
          assert.equal(response.headers.get("x-should-retry"), null);
          assert.equal(response.headers.get("retry-after"), "1");
          const body = (await response.json()) as { error: { code: string; retryable: boolean } };
          assert.equal(body.error.code, "upstream_outcome_unknown");
          assert.equal(body.error.retryable, true);
          assert.equal(f.remote.counts().modelSends, before + 1);
        }
      }
    } finally {
      await f.close();
    }
  },
);

for (const mode of ["close", "timeout"] as const)
  test(
    `device model ${mode} before ready stays retryable without sending an operation`,
    { timeout: 105000 },
    async () => {
      const f = await fixture();
      try {
        await f.login();
        await command(["agent", "add", "both", "models"], f.home);
        const origin = await f.start(),
          token = await f.token();
        f.remote.failBeforeReady(mode);
        const before = f.remote.counts();
        const response = await fetch(`${origin}/v1/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "synthetic-model" }),
        });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("x-should-retry"), null);
        assert.deepEqual(await response.json(), { error: "Model access is unavailable." });
        assert.equal(f.remote.counts().operationOpens, before.operationOpens);
        assert.equal(f.remote.counts().modelSends, before.modelSends);
      } finally {
        await f.close();
      }
    },
  );
