import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { ready } from "./native-client-fixture.ts";
import { deferred } from "./remote-fixture.ts";
import { fixtureHome } from "./support.ts";

test(
  "queued callers keep their order when the middle caller cancels",
  { timeout: 30_000 },
  async () => {
    const started = deferred<void>();
    const firstQueued = deferred<void>();
    const lastQueued = deferred<void>();
    const pending = new Map<number, ServerResponse>();
    const received: number[] = [];
    const upstream = createServer(async (incoming, outgoing) => {
      let body = "";
      for await (const chunk of incoming) body += chunk;
      const { index } = JSON.parse(body) as { index: number };
      received.push(index);
      pending.set(index, outgoing);
      if (received.length === 32) started.resolve();
      if (index === 32) firstQueued.resolve();
      if (index === 34) lastQueued.resolve();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const preload = join(profile.home, "observe-request.mjs");
    // Observe completed profile I/O in each HTTP request, without importing gateway internals.
    await writeFile(
      preload,
      `
    import files from "node:fs/promises";
    import { Server } from "node:http";
    import { AsyncLocalStorage } from "node:async_hooks";
    import { syncBuiltinESMExports } from "node:module";
    const context = new AsyncLocalStorage();
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, ...args) {
      if (event !== "request") return emit.call(this, event, ...args);
      const id = args[0].headers["x-fixture-id"];
      args[1].once("close", () => setImmediate(() => process.stderr.write("CLOSED " + id + "\\n")));
      return context.run(id, () => emit.call(this, event, ...args));
    };
    const open = files.open;
    files.open = async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith("/profile.json")) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          const id = context.getStore();
          if (id) setImmediate(() => process.stderr.write("QUEUED " + id + "\\n"));
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
  `,
    );
    const gateway = await profile.start(["--import", preload]);
    const token = await profile.secret("models");
    const start = (index: number, signal?: AbortSignal) =>
      fetch(`${gateway.origin}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-fixture-id": String(index),
        },
        body: JSON.stringify({ model: "synthetic", index }),
        signal,
      });
    const requests = Array.from({ length: 32 }, (_, index) => start(index));
    try {
      await started.promise;
      requests.push(start(32));
      await ready(gateway, /QUEUED 32\n/);
      const cancellation = new AbortController();
      const cancelled = assert.rejects(start(33, cancellation.signal), { name: "AbortError" });
      await ready(gateway, /QUEUED 33\n/);
      requests.push(start(34));
      await ready(gateway, /QUEUED 34\n/);
      cancellation.abort();
      await cancelled;
      await ready(gateway, /CLOSED 33\n/);
      pending.get(0)!.end("synthetic");
      await firstQueued.promise;
      assert.deepEqual(received.slice(32), [32]);
      pending.get(32)!.end("synthetic");
      await lastQueued.promise;
      assert.deepEqual(received.slice(32), [32, 34]);
      assert.equal(received.includes(33), false);
      for (const response of pending.values()) response.end("synthetic");
      for (const response of await Promise.all(requests)) {
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "synthetic");
      }
    } finally {
      for (const response of pending.values()) response.end();
      await gateway.stop();
      await Promise.allSettled(requests);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await profile.remove();
    }
  },
);
