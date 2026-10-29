import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { waitForPublicSite } from "./site-readiness.ts";

const headers = { "Content-Security-Policy": "default-src 'none'" };
const url = "https://site.example";

test("a resolving site recovers from 530, network failure and missing CSP before the deadline", async () => {
  let clock = 0;
  let attempts = 0;
  await waitForPublicSite(url, {
    timeoutMs: 180_000,
    intervalMs: 5_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    request: async (_url, options) => {
      assert.equal(options?.redirect, "manual");
      assert.ok(options?.signal instanceof AbortSignal);
      attempts += 1;
      if (attempts === 1) return new Response("error code: 1016", { status: 530 });
      if (attempts === 2) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return new Response("", { status: 200, headers: attempts === 3 ? {} : headers });
    },
  });
  assert.equal(attempts, 4);
  assert.equal(clock, 15_000);
});

for (const failure of ["530", "missing CSP", "network failure", "request timeout"]) {
  test(`readiness fails at the overall deadline after persistent ${failure}`, async () => {
    let clock = 0;
    let attempts = 0;
    const sleeps: number[] = [];
    await assert.rejects(waitForPublicSite(url, {
      timeoutMs: 12_000,
      intervalMs: 5_000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      request: async () => {
        attempts += 1;
        if (failure === "network failure") throw new TypeError("fetch failed");
        if (failure === "request timeout") throw new DOMException("request timed out", "TimeoutError");
        return new Response("", { status: failure === "530" ? 530 : 200 });
      },
    }), /did not return HTTP 200 with Content-Security-Policy within 12000ms/);
    assert.equal(attempts, 3);
    assert.equal(clock, 12_000);
    assert.deepEqual(sleeps, [5_000, 5_000, 2_000]);
  });
}

test("stalled HTTP requests honor per-request and overall deadlines", { timeout: 5_000 }, async (t) => {
  let attempts = 0;
  let stall = false;
  const server = createServer((_request, response) => {
    attempts += 1;
    if (attempts === 1 || stall) return;
    response.writeHead(200, headers).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await waitForPublicSite(`http://127.0.0.1:${address.port}`, {
    timeoutMs: 2_000,
    requestTimeoutMs: 100,
    intervalMs: 0,
  });
  assert.equal(attempts, 2);
  stall = true;
  await assert.rejects(waitForPublicSite(`http://127.0.0.1:${address.port}`, {
    timeoutMs: 100,
    requestTimeoutMs: 10_000,
    intervalMs: 0,
  }), /did not return HTTP 200 with Content-Security-Policy within 100ms/);
});

test("an unexpected redirect fails immediately without following it", async () => {
  let attempts = 0;
  await assert.rejects(waitForPublicSite(url, {
    request: async (_url, options) => {
      assert.equal(options?.redirect, "manual");
      attempts += 1;
      return new Response(null, { status: 302, headers: { Location: "/login" } });
    },
    sleep: async () => assert.fail("redirect must not retry"),
  }), /Public site returned HTTP 302/);
  assert.equal(attempts, 1);
});
