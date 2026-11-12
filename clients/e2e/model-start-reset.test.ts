import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, request, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { deferred } from "./remote-fixture.ts";
import { profileGate } from "./profile-gate.ts";
import { fixtureHome } from "./support.ts";

test(
  "a socket error during an upgrade profile read cannot stop the gateway",
  { timeout: 30_000 },
  async () => {
    const started = deferred<void>();
    const pending = new Set<ServerResponse>();
    let received = 0;
    let upgrades = 0;
    let release = false;
    const upstream = createServer(async (incoming, outgoing) => {
      for await (const _chunk of incoming) {
      }
      received++;
      if (received === 32) started.resolve();
      if (release) outgoing.end("synthetic");
      else pending.add(outgoing);
    });
    upstream.on("upgrade", (_request, socket) => {
      upgrades++;
      socket.destroy();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const gate = await profileGate(profile.home);
    const preload = join(profile.home, "reset-upgrade.mjs");
    // Node removes its HTTP socket error handler before handing the socket to an upgrade listener.
    await writeFile(
      preload,
      `
    import { Server } from "node:http";
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, ...args) {
      const result = emit.call(this, event, ...args);
      if (event === "upgrade") {
        const socket = args[1];
        setImmediate(() => socket.destroy(new Error("Synthetic socket reset during profile read")));
      }
      return result;
    };
  `,
    );
    const gateway = await profile.start([...gate.execArgv, "--import", preload]);
    const token = await profile.secret("models");
    const start = () =>
      fetch(`${gateway.origin}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "synthetic" }),
      });
    const requests = Array.from({ length: 32 }, start);
    try {
      await started.promise;
      await new Promise<void>((resolve, reject) => {
        const socket = request(`${gateway.origin}/v1/responses`, {
          headers: {
            authorization: `Bearer ${token}`,
            "x-fixture-id": "upgrade",
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        });
        socket.once("error", () => resolve());
        socket.once("response", () => reject(new Error("The pending upgrade must be reset.")));
        socket.once("upgrade", () =>
          reject(new Error("The cancelled upgrade must not be dispatched.")),
        );
        socket.end();
      });
      await gate.held(gateway, "upgrade");
      await gate.closed(gateway, "upgrade");
      await gate.release();
      release = true;
      for (const response of pending) response.end("synthetic");
      await Promise.all(
        requests.map(async (request) => {
          const response = await request;
          assert.equal(response.status, 200);
          assert.equal(await response.text(), "synthetic");
        }),
      );
      const fresh = await start();
      assert.equal(fresh.status, 200);
      assert.equal(await fresh.text(), "synthetic");
      assert.equal(received, 33);
      assert.equal(upgrades, 0, "The reset operation must never reach the upstream.");
    } finally {
      await gate.release();
      release = true;
      for (const response of pending) response.end();
      await gateway.stop();
      await Promise.allSettled(requests);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await profile.remove();
    }
  },
);
