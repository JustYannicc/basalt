import assert from "node:assert/strict";
import { test } from "node:test";
import { command } from "./support.ts";
import { fixture } from "./native-client-fixture.ts";
import { deferred } from "./remote-fixture.ts";
import { timerClock } from "./timer-clock.ts";

test("READY ends the handshake deadline while models are still thinking", async () => {
  const received = deferred<void>(),
    release = deferred<void>();
  let calls = 0;
  const f = await fixture({
    services: async () => {
      calls++;
      received.resolve();
      await release.promise;
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        chunks: [
          Buffer.from(
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"synthetic","status":"completed"}}\n\n',
          ),
        ],
      };
    },
  });
  try {
    await f.login();
    await command(["agent", "add", "both", "models"], f.home);
    const clock = await timerClock(f.home, 90_000);
    const origin = await f.start(clock.execArgv),
      token = await f.token();
    const pending = fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "synthetic", stream: true }),
    });
    await received.promise;
    await clock.advance();
    release.resolve();
    const response = await pending;
    assert.equal(
      response.status,
      200,
      "A model response cannot consume the completed READY deadline.",
    );
    assert.match(await response.text(), /response.completed/);
    assert.equal(calls, 1, "Thinking must not authorize replay.");
  } finally {
    release.resolve();
    await f.close();
  }
});

test("revoke cancels native thinking and refuses subsequent HTTP and WebSocket operations", async () => {
  const received = deferred<void>();
  let calls = 0;
  const f = await fixture({
    services: async ({ signal }) => {
      calls++;
      received.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { status: 200 };
    },
  });
  try {
    await f.login();
    await command(["agent", "add", "both", "models"], f.home);
    const origin = await f.start(),
      token = await f.token();
    const pending = fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "synthetic" }),
    });
    await received.promise;
    await command(["revoke"], f.home);
    const cancelled = await pending;
    assert.equal(cancelled.status, 502);
    assert.equal(cancelled.headers.get("x-should-retry"), "false");
    await cancelled.body?.cancel();
    const refused = await fetch(`${origin}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(refused.status, 401);
    await refused.body?.cancel();
    const { WebSocket } = await import("ws");
    const status = await new Promise<number>((resolve, reject) => {
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
        reject(new Error("Revoked WebSocket admitted."));
      });
    });
    assert.equal(status, 503);
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});
