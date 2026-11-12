import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type ClientRequest, type ServerResponse } from "node:http";
import { test } from "node:test";
import { deferred } from "./remote-fixture.ts";
import { fixtureHome } from "./support.ts";

test(
  "all 1600 model operations reach upstream before any response headers",
  { timeout: 20_000 },
  async (t) => {
    const allReceived = deferred<void>();
    const pending = new Map<number, ServerResponse>();
    const clients = new Set<ClientRequest>();
    const upstream = createServer(async (incoming, outgoing) => {
      let body = "";
      for await (const chunk of incoming) body += chunk;
      const { index } = JSON.parse(body) as { index: number };
      assert.equal(pending.has(index), false, "An operation must never be replayed.");
      pending.set(index, outgoing);
      if (pending.size === 1600) allReceived.resolve();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const gateway = await profile.start();
    const token = await profile.secret("models");
    t.after(async () => {
      for (const client of clients) client.destroy();
      await gateway.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await profile.remove();
    });
    const results: Promise<{ status: number; body: string }>[] = [];
    for (let index = 0; index < 1600; index++) {
      const connected = deferred<void>();
      results.push(
        new Promise((resolve, reject) => {
          const client = request(
            `${gateway.origin}/v1/responses`,
            {
              method: "POST",
              agent: false,
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            },
            (response) => {
              let body = "";
              response.on("data", (chunk: Buffer) => {
                body += chunk;
              });
              response.once("error", reject);
              response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
            },
          );
          clients.add(client);
          client.once("socket", (socket) => socket.once("connect", () => connected.resolve()));
          client.once("error", (error) => {
            connected.resolve();
            reject(error);
          });
          client.end(JSON.stringify({ model: "synthetic", stream: true, index }));
        }),
      );
      // Establish the caller socket before the next start to exclude OS accept backlog limits.
      await connected.promise;
    }
    const timer = setTimeout(() => allReceived.resolve(), 5_000);
    await allReceived.promise;
    clearTimeout(timer);
    assert.equal(pending.size, 1600, "Slow model headers must not hold local start capacity.");
    for (const [index, response] of pending) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `event: response.completed\ndata: {"type":"response.completed","response":{"id":"r${index}","status":"completed"}}\n\n`,
      );
    }
    for (const [index, response] of (await Promise.all(results)).entries()) {
      assert.equal(response.status, 200);
      assert.match(response.body, /event: response.completed/);
      assert.match(response.body, new RegExp(`"id":"r${index}"`));
    }
  },
);
