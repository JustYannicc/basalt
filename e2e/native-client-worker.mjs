import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import {
  Miniflare,
  fetch as runtimeFetch,
  Response as RuntimeResponse,
  WebSocketPair,
} from "miniflare";
import { syntheticTunnelModel } from "../.upstream/e2e/support/native-tunnel-model.ts";

/** The real production Router with external model/pool peers and the real hosted tools service. */
export async function startNativeClientWorker(root) {
  let toolsOrigin,
    pool,
    refreshes = 0,
    initialToken = true,
    cancelled = 0;
  const slow = { bytes: 0, blocked: false, total: 32 * 1024 * 1024 };
  const slowChunk = Buffer.alloc(64 * 1024, "x");
  const holds = new Set();
  let nextCancellation;
  const model = createServer((request, response) => {
    assert.ok(request.headers["x-basalt-native-assertion"]);
    assert.equal(request.headers.cookie, undefined);
    if (request.url === "/v1/models") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "synthetic-model" }] }));
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", async () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      if (JSON.parse(Buffer.concat(chunks).toString() || "{}").mode === "slow") {
        try {
          while (slow.bytes < slow.total && !response.destroyed) {
            slow.bytes += slowChunk.length;
            if (!response.write(slowChunk)) {
              slow.blocked = true;
              await once(response, "drain", { signal: AbortSignal.timeout(30000) });
              slow.blocked = false;
            }
          }
          response.end();
        } catch {
          response.destroy();
        }
        return;
      }
      const finish = () => {
        holds.delete(finish);
        response.end("data: complete\n\n");
      };
      holds.add(finish);
      response.once("close", () => {
        holds.delete(finish);
        if (!response.writableEnded) {
          cancelled++;
          nextCancellation?.();
        }
      });
    });
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const bundle = await build({
    stdin: {
      contents: 'export { default } from "./src/router.ts";',
      resolveDir: root,
      sourcefile: "native-client-entry.ts",
    },
    absWorkingDir: root,
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    target: "es2023",
  });
  const runtime = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    workers: [
      {
        name: "router",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { DASHBOARD_HOST: "127.0.0.1", POOL_APP_SIGNING_KEY: "ab".repeat(32) },
        serviceBindings: {
          CATALOG_SERVICE: () => new RuntimeResponse(null, { status: 404 }),
          TOOLS_SERVICE: async (request) => {
            if (!toolsOrigin) return new RuntimeResponse(null, { status: 503 });
            const target = new URL(request.url);
            const token = target.pathname === "/api/auth/oauth2/token";
            const fields = token ? new URLSearchParams(await request.clone().text()) : undefined;
            const refreshing = fields?.get("grant_type") === "refresh_token";
            if (refreshing) refreshes++;
            const response = await runtimeFetch(
              new URL(target.pathname + target.search, toolsOrigin),
              {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                body: request.body,
                duplex: "half",
                redirect: "manual",
                signal: request.signal,
              },
            );
            if (token && !refreshing && response.ok && initialToken) {
              initialToken = false;
              // A shorter external lifetime hint requests real renewal without waiting an hour.
              // The actual server-issued tokens, grant, scopes and permissions stay unchanged.
              const body = await response.json();
              assert.equal(body.expires_in, 3600);
              return RuntimeResponse.json({ ...body, expires_in: 1 });
            }
            return new RuntimeResponse(response.body, {
              status: response.status,
              headers: Object.fromEntries(response.headers),
            });
          },
          POOL_SERVICE: "synthetic-model",
        },
      },
      {
        name: "synthetic-model",
        modules: true,
        script: syntheticTunnelModel,
        compatibilityDate: "2026-08-06",
        bindings: { MODEL_ORIGIN: `http://127.0.0.1:${model.address().port}` },
        serviceBindings: {
          LIFETIME: (request) => {
            assert.ok(pool);
            const identity = JSON.parse(
              Buffer.from(
                request.headers.get("x-basalt-native-session").split(".")[1],
                "base64url",
              ).toString(),
            );
            const pair = new WebSocketPair();
            pair[1].accept();
            const stop = pool.watch(identity.grant, () => pair[1].close(1000, "Revoked"));
            pair[1].addEventListener("close", stop);
            return new RuntimeResponse(null, { status: 101, webSocket: pair[0] });
          },
        },
      },
    ],
  });
  const origin = (await runtime.ready).origin;
  return {
    origin,
    connect: (backend, lifetime) => {
      toolsOrigin = backend;
      pool = lifetime;
    },
    complete: () => {
      for (const finish of holds) finish();
    },
    refreshes: () => refreshes,
    progress: () => ({ ...slow }),
    nextCancellation: () => {
      const before = cancelled;
      return {
        wait: () =>
          cancelled > before
            ? Promise.resolve()
            : new Promise((resolve) => {
                nextCancellation = resolve;
              }),
      };
    },
    close: async () => {
      for (const finish of holds) finish();
      await runtime.dispose();
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
    },
  };
}
