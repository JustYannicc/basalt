import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { command, fixtureHome } from "./support.ts";
import { deferred } from "./remote-fixture.ts";
import { fixture } from "./native-client-fixture.ts";

test(
  "two hundred streamed responses stay open while pending starts queue",
  { timeout: 30_000 },
  async () => {
    const firstStarts = deferred<void>();
    const pending = new Set<ServerResponse>();
    let requests = 0;
    let peakPending = 0;
    const upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {
      }
      requests++;
      pending.add(response);
      peakPending = Math.max(peakPending, pending.size);
      if (requests === 32) firstStarts.resolve();
      if (requests > 32) {
        pending.delete(response);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
      }
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const gateway = await profile.start();
    const token = await profile.secret("models");
    const responses: Response[] = [];
    try {
      const burst = Promise.all(
        Array.from({ length: 200 }, async () => {
          const response = await fetch(`${gateway.origin}/v1/responses`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "synthetic", stream: true }),
          });
          responses.push(response);
          return response;
        }),
      );
      await firstStarts.promise;
      assert.equal(requests, 32);
      for (const response of pending) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
      }
      pending.clear();
      const opened = await burst;
      assert.equal(opened.length, 200);
      assert.ok(opened.every((response) => response.status === 200));
      assert.equal(requests, 200);
      assert.equal(peakPending, 32);
      await Promise.all(opened.map((response) => response.body!.cancel()));
    } finally {
      await Promise.allSettled(responses.map((response) => response.body?.cancel()));
      await gateway.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await profile.remove();
    }
  },
);

test(
  "two hundred native model streams finish through separate tunnel sockets",
  { timeout: 30_000 },
  async () => {
    const connection = await fixture();
    try {
      await connection.login();
      await command(["agent", "add", "both", "models", "tools"], connection.home);
      const origin = await connection.start();
      const token = await connection.token();
      const responses = await Promise.all(
        Array.from({ length: 200 }, () =>
          fetch(`${origin}/v1/responses`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "synthetic", stream: true }),
          }),
        ),
      );
      assert.ok(responses.every((response) => response.status === 200));
      assert.equal(connection.remote.counts().modelSends, 200);
      connection.remote.complete();
      for (const body of await Promise.all(responses.map((response) => response.text()))) {
        assert.match(body, /data: first/);
        assert.match(body, /data: complete/);
      }
    } finally {
      await connection.close();
    }
  },
);

test(
  "a full start queue refuses safely and recovers after stalled headers arrive",
  { timeout: 30_000 },
  async () => {
    const pending = new Set<ServerResponse>();
    let release = false;
    let upstreamCalls = 0;
    const upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {
      }
      upstreamCalls++;
      if (release) response.end("synthetic");
      else pending.add(response);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const gateway = await profile.start();
    const token = await profile.secret("models");
    const refused = deferred<Response>();
    const requests = Array.from({ length: 1057 }, async () => {
      const response = await fetch(`${gateway.origin}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "synthetic" }),
      });
      if (response.status === 503) refused.resolve(response);
      await response.text();
      return response.status;
    });
    try {
      const response = await refused.promise;
      assert.equal(response.headers.get("retry-after"), "1");
      assert.notEqual(response.headers.get("x-should-retry"), "false");
      assert.equal(upstreamCalls, 32);
      release = true;
      for (const response of pending) response.end("synthetic");
      pending.clear();
      const statuses = await Promise.all(requests);
      assert.equal(statuses.filter((status) => status === 200).length, 1056);
      assert.equal(statuses.filter((status) => status === 503).length, 1);
      assert.equal(upstreamCalls, 1056, "Refused work must never reach the upstream.");
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

test(
  "disconnect cancels queued starts without sending them after reconnect",
  { timeout: 30_000 },
  async () => {
    const firstStarts = deferred<void>();
    const pending = new Set<ServerResponse>();
    const received: number[] = [];
    let release = false;
    const upstream = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push(JSON.parse(body).index);
      if (received.length === 32) firstStarts.resolve();
      if (release) response.end("synthetic");
      else pending.add(response);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const gateway = await profile.start();
    const token = await profile.secret("models");
    const start = (index: number) =>
      fetch(`${gateway.origin}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ index }),
      });
    const requests = Array.from({ length: 32 }, (_, index) => start(index));
    try {
      await firstStarts.promise;
      const queued = start(32);
      await command(["disconnect"], profile.home);
      const cancelled = await queued;
      assert.equal(cancelled.status, 503);
      await cancelled.body?.cancel();
      await Promise.all(
        requests.map(async (request) => {
          const response = await request;
          await response.body?.cancel();
        }),
      );
      assert.equal(received.includes(32), false);
      release = true;
      for (const response of pending) response.end();
      await command(["reconnect"], profile.home);
      const fresh = await start(33);
      assert.equal(fresh.status, 200);
      await fresh.body?.cancel();
      assert.deepEqual(
        received.toSorted((left, right) => left - right),
        [...Array.from({ length: 32 }, (_, index) => index), 33],
      );
    } finally {
      await gateway.stop();
      await Promise.allSettled(requests);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await profile.remove();
    }
  },
);
