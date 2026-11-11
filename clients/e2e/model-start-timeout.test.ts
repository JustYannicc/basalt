import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { deferred } from "./remote-fixture.ts";
import { fixtureHome } from "./support.ts";

test(
  "an expired queued request stays retryable and never reaches the provider",
  { timeout: 30_000 },
  async () => {
    const started = deferred<void>();
    const pending = new Set<ServerResponse>();
    const received: number[] = [];
    let release = false;
    const upstream = createServer(async (incoming, outgoing) => {
      let body = "";
      for await (const chunk of incoming) body += chunk;
      received.push(JSON.parse(body).index);
      if (received.length === 32) started.resolve();
      if (release) outgoing.end("synthetic");
      else pending.add(outgoing);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const preload = join(profile.home, "expire-queue.mjs");
    // Fire the real gateway deadline without spending thirty seconds in a stalled fixture.
    await writeFile(
      preload,
      `
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, milliseconds, ...args) =>
      timeout(callback, milliseconds === 30_000 ? 0 : milliseconds, ...args);
  `,
    );
    const gateway = await profile.start(["--import", preload]);
    const token = await profile.secret("models");
    const start = (index: number) =>
      fetch(`${gateway.origin}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "synthetic", index }),
      });
    const requests = Array.from({ length: 32 }, (_, index) => start(index));
    try {
      await started.promise;
      const expired = await start(32);
      assert.equal(expired.status, 503);
      assert.equal(expired.headers.get("retry-after"), "1");
      assert.notEqual(expired.headers.get("x-should-retry"), "false");
      await expired.body?.cancel();
      assert.equal(received.includes(32), false);
      release = true;
      for (const response of pending) response.end("synthetic");
      await Promise.all(
        requests.map(async (request) => {
          const response = await request;
          assert.equal(response.status, 200);
          await response.text();
        }),
      );
      const fresh = await start(33);
      assert.equal(fresh.status, 200);
      await fresh.text();
      assert.deepEqual(
        received.toSorted((left, right) => left - right),
        [...Array.from({ length: 32 }, (_, index) => index), 33],
      );
    } finally {
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
