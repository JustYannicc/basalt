import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "../pool-test-runtime/index.ts";
import { openTunnel } from "../../clients/connection/tunnel.ts";
import type { WireSocket } from "../../clients/contracts/transport.ts";

async function bundle(name: string) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../pool-tests/${name}.mjs`, import.meta.url))],
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
              'export default {Client: class {constructor(){throw new Error("Database outside proof");}}};',
            loader: "js",
          }));
        },
      },
    ],
  });
  return result.outputFiles[0]!.text;
}

for (const observed of [false, true])
  test(`a 65535-byte native create reaches the binary model consumer with terminal observation ${observed ? "on" : "off"}`, async () => {
    const mf = new Miniflare({
      workers: [
        {
          name: "router",
          modules: true,
          script: await bundle("terminal-binary-router"),
          compatibilityDate: "2026-09-08",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: { POOL: "pool" },
        },
        {
          name: "pool",
          modules: true,
          script: await bundle("model-lifetime-worker"),
          compatibilityDate: "2026-09-08",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            PROXY: { className: "Proxy", useSQLite: true },
            NODE: { className: "ModelLifetimeNode", useSQLite: true },
          },
          bindings: { MODEL_DRAIN: true, TERMINAL_RECORDING: observed ? "enabled" : "disabled" },
        },
      ],
    });
    const abort = new AbortController();
    let close = () => {};
    try {
      assert.equal((await mf.dispatchFetch("https://fixture/seed")).status, 200);
      const response = await mf.dispatchFetch("https://fixture/tunnel", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "basalt.tunnel.v2",
          authorization: "Bearer synthetic",
        },
      });
      assert.equal(response.status, 101);
      const socket = response.webSocket!;
      const wire: WireSocket = {
        send: (data) => socket.send(data),
        close: () => {
          if (socket.readyState === 1) socket.close(1000, "done");
        },
        listen(listener) {
          const message = (event: { data: unknown }) =>
            listener({ type: "message", data: event.data });
          const closed = (event: { code: number }) => listener({ type: "close", code: event.code });
          const error = () => listener({ type: "error" });
          socket.addEventListener("message", message);
          socket.addEventListener("close", closed);
          socket.addEventListener("error", error);
          return () => {
            socket.removeEventListener("message", message);
            socket.removeEventListener("close", closed);
            socket.removeEventListener("error", error);
          };
        },
      };
      const operation = openTunnel(
        wire,
        {
          operation: {
            service: "models",
            method: "GET",
            path: "/v1/responses",
            transport: "websocket",
          },
          headers: { accept: "application/json" },
        },
        abort.signal,
      );
      close = operation.close;
      socket.accept();
      assert.equal((await operation.response).status, 101);
      const raw = JSON.stringify({
        type: "response.create",
        model: "claude-opus-5-5",
        store: false,
        stream: true,
        max_output_tokens: 8,
        input: "Reply with ok.",
      });
      const payload = new TextEncoder().encode(
        raw.slice(0, -1) + " ".repeat(65_535 - raw.length) + "}",
      );
      assert.equal(payload.byteLength, 65_535);
      await operation.send(payload, true, true);
      const part = await operation.next();
      assert.ok(part, "The model must acknowledge and answer the complete binary create.");
      assert.equal(part.text, true);
      assert.equal(part.more, false);
      assert.equal(JSON.parse(new TextDecoder().decode(part.bytes)).type, "response.completed");
      operation.consumed(part.bytes.byteLength);
      const node = await (await mf.dispatchFetch("https://fixture/node-state")).json();
      assert.partialDeepStrictEqual(node, {
        dispatches: 1,
        messages: [{ binary: true, bytes: 65_540, message: JSON.parse(raw) }],
      });
      const terminals = (await (await mf.dispatchFetch("https://fixture/terminals")).json()) as {
        starts: unknown[];
        finishes: { outcome: string }[];
      };
      assert.equal(terminals.starts.length, observed ? 1 : 0);
      assert.deepEqual(
        terminals.finishes.map((finish) => finish.outcome),
        observed ? ["complete"] : [],
      );
    } finally {
      try {
        close();
      } finally {
        abort.abort();
        await mf.dispose();
      }
    }
  });
