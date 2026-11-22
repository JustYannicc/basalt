import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  RegistryReadError,
  registryReader,
  type RegistryReadOptions,
} from "../.upstream/scripts/e2e-npm-fetch.ts";

const url = "https://registry.invalid/react";
const timeout = () => new DOMException("The operation timed out.", "TimeoutError");
const reset = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  });

/** A fake registry that answers each call from a script of outcomes. */
function harness(outcomes: (() => Response | Error)[], options: RegistryReadOptions = {}) {
  const calls: string[] = [];
  const delays: number[] = [];
  const logs: string[] = [];
  const read = registryReader({
    fetch: async (input) => {
      calls.push(String(input));
      const outcome = outcomes[calls.length - 1]?.() ?? new Error("unexpected extra call");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    log: (line) => logs.push(line),
    ...options,
  });
  return { read, calls, delays, logs };
}

test("timeouts and resets retry with backoff, then the response is read", async () => {
  const registry = harness([timeout, reset, () => new Response("archive")]);
  assert.equal(await registry.read(url, (response) => response.text()), "archive");
  assert.equal(registry.calls.length, 3);
  assert.deepEqual(registry.delays, [1000, 2000]);
  assert.match(registry.logs[0]!, /attempt 1\/4 failed \(TimeoutError/);
  assert.match(
    registry.logs[1]!,
    /attempt 2\/4 failed \(TypeError: fetch failed <- Error ECONNRESET/,
  );
  assert.equal(registry.logs.length, 2);
});

test("a reset while reading the body retries the whole request", async () => {
  let reads = 0;
  const registry = harness([() => new Response("first"), () => new Response("second")]);
  const body = await registry.read(url, async (response) => {
    const text = await response.text();
    if (++reads === 1) throw reset();
    return text;
  });
  assert.equal(body, "second");
  assert.equal(registry.calls.length, 2);
});

test("429, 5xx, temporary DNS failures and refused connections retry", async () => {
  const registry = harness(
    [
      () => new Response("", { status: 429 }),
      () => new Response("", { status: 503 }),
      () =>
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo"), { code: "EAI_AGAIN" }),
        }),
      () =>
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
        }),
      () => new Response("ok"),
    ],
    // Four transient failures in a row need a fifth attempt here.
    { attempts: 5 },
  );
  assert.equal(await registry.read(url, (response) => response.text()), "ok");
  assert.equal(registry.calls.length, 5);
  assert.match(registry.logs[0]!, /HTTP 429/);
  assert.match(registry.logs[1]!, /HTTP 503/);
});

test("a persistent outage fails after four attempts with the real cause", async () => {
  const registry = harness([reset, reset, reset, reset]);
  await assert.rejects(
    registry.read(url, (response) => response.text()),
    (error: unknown) =>
      error instanceof RegistryReadError &&
      /failed after 4 attempts: TypeError: fetch failed <- Error ECONNRESET/.test(error.message),
  );
  assert.equal(registry.calls.length, 4);
  assert.equal(registry.logs.length, 3);
  assert.deepEqual(registry.delays, [1000, 2000, 4000]);
});

test("a persistent 5xx reports its last status", async () => {
  const registry = harness(
    Array.from({ length: 4 }, () => () => new Response("", { status: 502 })),
  );
  await assert.rejects(
    registry.read(url, (response) => response.text()),
    /after 4 attempts: HTTP 502/,
  );
});

test("other 4xx answers and non-network errors fail at once", async () => {
  const missing = harness([() => new Response("", { status: 404 })]);
  await assert.rejects(
    missing.read(url, (response) => response.text()),
    /returned 404/,
  );
  assert.equal(missing.calls.length, 1);
  assert.deepEqual(missing.logs, []);
  const broken = harness([() => new Response("not json")]);
  await assert.rejects(
    broken.read(url, (response) => response.json()),
    RegistryReadError,
  );
  assert.equal(broken.calls.length, 1);
});

test("jitter keeps each delay within half to one and a half of its backoff step", async () => {
  for (const random of [0, 0.999]) {
    const registry = harness([reset, reset, () => new Response("ok")], { random: () => random });
    await registry.read(url, (response) => response.text());
    registry.delays.forEach((delay, index) => {
      const step = 1000 * 2 ** index;
      assert.ok(delay >= step * 0.5 && delay <= step * 1.5, `${delay} for step ${step}`);
    });
  }
});

test("real hangs, resets and cut bodies retry and then fail with their socket cause", async (context) => {
  const server = createServer((request, response) => {
    if (request.url === "/hang") return;
    if (request.url === "/reset") return request.socket.destroy();
    response.writeHead(200, { "content-length": "100" });
    response.write("partial");
    setTimeout(() => request.socket.destroy(), 10);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  for (const [path, cause] of [
    ["/hang", /TimeoutError/],
    ["/reset", /UND_ERR_SOCKET|ECONNRESET/],
    ["/cut-body", /UND_ERR_SOCKET|ECONNRESET/],
  ] as const) {
    const logs: string[] = [];
    const read = registryReader({
      attempts: 2,
      timeoutMs: 300,
      sleep: async () => {},
      log: (line) => logs.push(line),
    });
    await assert.rejects(
      read(`http://127.0.0.1:${port}${path}`, (response) => response.arrayBuffer()),
      (error: unknown) =>
        error instanceof RegistryReadError &&
        /failed after 2 attempts/.test(error.message) &&
        cause.test(error.message),
    );
    assert.equal(logs.length, 1, path);
  }
});
