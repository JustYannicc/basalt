import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isArrayBuffer } from "node:util/types";
import { build } from "esbuild";
import { Miniflare } from "../pool-test-runtime/index.ts";

async function fixture() {
  const bundle = await build({
    entryPoints: [
      fileURLToPath(new URL("../pool-tests/model-lifetime-worker.mjs", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    external: ["cloudflare:workers"],
    plugins: [
      {
        name: "no-fixture-database",
        setup(build) {
          build.onResolve({ filter: /^pg$/ }, () => ({ path: "pg", namespace: "fixture" }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              'export default {Client: class {constructor(){throw new Error("Database outside this proof");}}};',
            loader: "js",
          }));
        },
      },
    ],
  });
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      PROXY: { className: "Proxy", useSQLite: true },
      NODE: { className: "ModelLifetimeNode", useSQLite: true },
    },
  });
  const request = (path: string) => mf.dispatchFetch(`https://fixture${path}`);
  assert.equal((await request("/seed")).status, 200);
  const connect = async (native = false, legacy = false, unleased = false) => {
    const response = await mf.dispatchFetch(
      `https://fixture/v1/lifetime-fixture${legacy ? `?legacy=1${unleased ? "&unleased=1" : ""}` : ""}`,
      {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "raw.fixture",
          ...(native ? { "x-basalt-native-assertion": "fixture" } : {}),
        },
      },
    );
    assert.equal(response.status, 101);
    assert.equal(response.headers.get("Sec-WebSocket-Protocol"), "raw.fixture");
    assert.equal(response.headers.has("X-Signalbox-Pool-Dispatch-Timing"), false);
    const ws = response.webSocket!;
    ws.accept();
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), {
        once: true,
      }),
    );
    const receive = () =>
      new Promise<unknown>((resolve) =>
        ws.addEventListener("message", (event) => resolve(event.data), { once: true }),
      );
    return { ws, closed, receive };
  };
  return { mf, request, connect };
}

const empty = { native: 0, model: 0, old: 0, candidate: 0, retired: [] };

test("a selected raw socket prepares Node lifetime before dispatch, preserves bytes beyond 16 MiB and releases both leases", async () => {
  const f = await fixture();
  try {
    const socket = await f.connect();
    const first = socket.receive();
    socket.ws.send("raw μ");
    assert.equal(await first, "raw μ");
    assert.deepEqual(await (await f.request("/state")).json(), { ...empty, model: 1, old: 1 });
    for (let i = 0; i < 20; i++) {
      const payload = new Uint8Array(1024 * 1024);
      payload.fill(i);
      const echo = socket.receive();
      socket.ws.send(payload);
      const result = await echo;
      assert.ok(isArrayBuffer(result));
      assert.deepEqual(new Uint8Array(result), payload);
    }
    const zero = socket.receive();
    socket.ws.send(new ArrayBuffer(0));
    const zeroResult = await zero;
    assert.ok(isArrayBuffer(zeroResult));
    assert.equal(zeroResult.byteLength, 0);
    socket.ws.send("finish");
    assert.equal((await socket.closed).code, 1000);
    assert.deepEqual(await (await f.request("/settled")).json(), empty);
  } finally {
    await f.mf.dispose();
  }
});

for (const terminal of ["client", "upstream", "revoke", "unknown"])
  test(`native ${terminal} closure releases device, membership and selected-slot leases without replay`, async () => {
    const f = await fixture();
    try {
      const socket = await f.connect(true);
      const echo = socket.receive();
      socket.ws.send("one dispatch");
      assert.equal(await echo, "one dispatch");
      assert.deepEqual(await (await f.request("/state")).json(), {
        ...empty,
        native: 1,
        model: 1,
        old: 1,
      });
      if (terminal === "client") socket.ws.close(1000, "client");
      else if (terminal === "upstream") socket.ws.send("upstream-close");
      else if (terminal === "revoke") assert.equal((await f.request("/revoke")).status, 200);
      else assert.equal((await f.request("/node-break")).status, 204);
      const ended = await socket.closed;
      if (terminal === "unknown") assert.notEqual(ended.code, 1000);
      assert.deepEqual(await (await f.request("/settled")).json(), empty);
      const node: unknown = await (await f.request("/node-state")).json();
      assert.partialDeepStrictEqual(node, { dispatches: 1 });
    } finally {
      await f.mf.dispose();
    }
  });

test("a malformed completion handshake cannot dispatch inference and releases pending leases", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/node-mode?mode=invalid")).status, 204);
    const response = await f.mf.dispatchFetch("https://fixture/v1/lifetime-fixture", {
      headers: { Upgrade: "websocket", "x-basalt-native-assertion": "fixture" },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await (await f.request("/settled")).json(), empty);
    assert.partialDeepStrictEqual(await (await f.request("/node-state")).json(), { dispatches: 0 });
  } finally {
    await f.mf.dispose();
  }
});

test("a closed native passthrough unblocks retirement of its exact draining runtime once", async () => {
  const f = await fixture();
  try {
    const socket = await f.connect();
    assert.equal((await f.request("/promote")).status, 200);
    const refused = await f.request("/retire");
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { reason: "draining" });
    socket.ws.close(1000, "done");
    await socket.closed;
    assert.deepEqual(await (await f.request("/settled")).json(), empty);
    for (let i = 0; i < 2; i++) {
      const receipt = await f.request("/retire");
      assert.equal(receipt.status, 200);
      assert.partialDeepStrictEqual(await receipt.json(), {
        operationId: "retire-old",
        status: "retired",
        identity: { bootId: "boot-old" },
      });
    }
    assert.deepEqual(await (await f.request("/state")).json(), { ...empty, retired: ["boot-old"] });
  } finally {
    await f.mf.dispose();
  }
});

test("the legacy dispatch path uses the same private lifetime and releases both native leases", async () => {
  const f = await fixture();
  try {
    const socket = await f.connect(true, true);
    assert.deepEqual(await (await f.request("/state")).json(), { ...empty, native: 1, model: 1 });
    socket.ws.send("finish");
    await socket.closed;
    assert.deepEqual(await (await f.request("/settled")).json(), empty);
    assert.partialDeepStrictEqual(await (await f.request("/node-state")).json(), { dispatches: 1 });
  } finally {
    await f.mf.dispose();
  }
});

test("unleased legacy raw sockets preserve their existing native path without a private channel", async () => {
  const f = await fixture();
  try {
    const socket = await f.connect(false, true, true);
    assert.deepEqual(await (await f.request("/state")).json(), empty);
    assert.partialDeepStrictEqual(await (await f.request("/node-state")).json(), {
      dispatches: 1,
      lifetimes: 0,
    });
    const echo = socket.receive();
    socket.ws.send("legacy raw");
    assert.equal(await echo, "legacy raw");
    socket.ws.close(1000, "done");
    await socket.closed;
    assert.deepEqual(await (await f.request("/state")).json(), empty);
  } finally {
    await f.mf.dispose();
  }
});
