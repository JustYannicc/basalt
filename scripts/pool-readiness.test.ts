import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { waitForPoolStatus } from "./pool-readiness.ts";

const name = "Pool model authentication GET /v1/models";

test("a cold pool recovers from 503, a request timeout and a connection failure", async () => {
  let clock = 0;
  let attempts = 0;
  await waitForPoolStatus(name, 401, async () => {
    attempts += 1;
    if (attempts === 1) return new Response(null, { status: 503 });
    if (attempts === 2) throw new DOMException("request timed out", "TimeoutError");
    if (attempts === 3) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    return new Response(null, { status: 401 });
  }, {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(attempts, 4);
  assert.equal(clock, 15_000);
});

for (const failure of ["503", "request timeout", "connection failure"]) {
  test(`persistent ${failure} fails with the request name at the overall deadline`, async () => {
    let clock = 0;
    let attempts = 0;
    const sleeps: number[] = [];
    await assert.rejects(waitForPoolStatus(name, 401, async () => {
      attempts += 1;
      if (failure === "request timeout") throw new DOMException("request timed out", "TimeoutError");
      if (failure === "connection failure") throw new TypeError("fetch failed");
      return new Response(null, { status: 503 });
    }, {
      timeoutMs: 12_000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    }), {
      message: `${name} did not return HTTP 401 within 12000ms`,
    });
    assert.equal(attempts, 3);
    assert.equal(clock, 12_000);
    assert.deepEqual(sleeps, [5_000, 5_000, 2_000]);
  });
}

for (const status of [200, 302, 403, 404]) {
  test(`unexpected HTTP ${status} fails immediately instead of passing the authentication gate`, async () => {
    let attempts = 0;
    await assert.rejects(waitForPoolStatus(name, 401, async () => {
      attempts += 1;
      return new Response(null, { status });
    }, {
      sleep: async () => assert.fail("unexpected non-5xx responses must not retry"),
    }), { message: `${name} returned HTTP ${status}; expected 401` });
    assert.equal(attempts, 1);
  });
}

test("a ready pool passes on its first request without waiting", async () => {
  let attempts = 0;
  await waitForPoolStatus(name, 401, async () => {
    attempts += 1;
    return new Response(null, { status: 401 });
  }, { sleep: async () => assert.fail("a ready pool must not wait") });
  assert.equal(attempts, 1);
});

test("an expected status arriving after the overall deadline does not pass", async () => {
  let clock = 0;
  await assert.rejects(waitForPoolStatus(name, 401, async () => {
    clock = 12_001;
    return new Response(null, { status: 401 });
  }, {
    timeoutMs: 12_000,
    now: () => clock,
    sleep: async () => assert.fail("the deadline has already expired"),
  }), { message: `${name} did not return HTTP 401 within 12000ms` });
});

test("stalled HTTP requests honor both the per-request timeout and the shorter remaining deadline", { timeout: 5_000 }, async (t) => {
  let attempts = 0;
  let stall = false;
  const server = createServer((_request, response) => {
    attempts += 1;
    if (attempts === 1 || stall) return;
    response.writeHead(401).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = (signal: AbortSignal) => fetch(`http://127.0.0.1:${address.port}`, { redirect: "manual", signal });
  await waitForPoolStatus(name, 401, request, {
    timeoutMs: 2_000,
    requestTimeoutMs: 100,
    intervalMs: 0,
  });
  assert.equal(attempts, 2);
  stall = true;
  await assert.rejects(waitForPoolStatus(name, 401, request, {
    timeoutMs: 100,
    requestTimeoutMs: 15_000,
    intervalMs: 0,
  }), { message: `${name} did not return HTTP 401 within 100ms` });
});
