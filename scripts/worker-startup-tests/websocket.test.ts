import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadMiniflare } from "../startup-profiler/profile.ts";
import { readBundle } from "../worker-startup.ts";

// Use the deploy bundles. Only the unavailable Container TCP port and key database are adapters.
// The Router, Worker auth gate, PoolContainer, lifecycle and WebSocket responses are real code.
function modules(name: string) {
  const bundle = readBundle(name, `.alchemy/bundles/${name}`);
  return {
    entry: join(bundle.directory, bundle.entry),
    files: bundle.modules.map((file) => ({
      type: file.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
      path: join(bundle.directory, file), contents: readFileSync(join(bundle.directory, file)),
    })),
  };
}

const origin = `
let connections = 0;
export default { fetch(request) {
  if (new URL(request.url).pathname === '/stats') return Response.json({ connections });
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
  connections++;
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(JSON.stringify({ url: request.url, method: request.method,
    authorization: request.headers.get('Authorization'), key: request.headers.get('X-Api-Key'),
    beta: request.headers.get('OpenAI-Beta') }));
  server.addEventListener('message', event => server.send(event.data));
  server.addEventListener('close', event => server.close(event.code, event.reason));
  return new Response(null, { status: 101, webSocket: client,
    headers: { 'x-codex-turn-state': request.headers.get('x-codex-turn-state') ?? '' } });
} };`;

test("Responses WebSockets cross the built Router, auth gate and pool DO without losing frames", { timeout: 30_000 }, async () => {
  const router = modules("Router");
  const pool = modules("PoolWorker");
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  const compatibility = { compatibilityDate: "2026-09-08", compatibilityFlags: ["nodejs_compat"] };
  const fixture = resolve(".generated/websocket-fixture.js");
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { ...compatibility, name: "router", modulesRoot: "/", modules: [
      { type: "ESModule", path: `${fixture}-router.js`, contents: `
        import router from ${JSON.stringify(router.entry)};
        export default { fetch(request, env, ctx) { return router.fetch(request,
          { ...env, DASHBOARD_HOST: 'pool.example', ASSETS: { fetch: async () => new Response(null, { status: 404 }) } }, ctx); } };` },
      ...router.files,
    ], serviceBindings: { POOL_SERVICE: "pool" } },
    { ...compatibility, name: "pool", modulesRoot: "/", modules: [
      { type: "ESModule", path: fixture, contents: `
        import { DurableObject } from 'cloudflare:workers';
        import { PoolContainer, handlePoolWorkerRequest } from ${JSON.stringify(pool.entry)};
        export class SocketPool extends DurableObject {
          constructor(ctx, env) {
            super(ctx, env);
            const container = { running: false, start() { this.running = true; }, async destroy() { this.running = false; }, async setInactivityTimeout() {},
              getTcpPort(port) { return { fetch: async request => {
                if (port === 8318) return Response.json({ boot_id: 'fixture', started_at: '2026-01-01T00:00:00Z' });
                if (port !== 8317 || !request.url.startsWith('http://pool/')) throw new Error('Wrong container port or scheme');
                return env.ORIGIN.fetch(request);
              } }; } };
            this.pool = new PoolContainer({ container, storage: ctx.storage, waitUntil: work => ctx.waitUntil(work) }, env);
          }
          fetch(request) { return this.pool.fetch(request); }
        }
        export default { fetch(request, env) {
          return handlePoolWorkerRequest(request, { ...env,
            POOL_AUTH_DATABASE: { connectionString: 'fixture' },
            PoolContainer: { jurisdiction(region) {
              if (region !== 'eu') throw new Error('Wrong jurisdiction');
              return env.POOL_OBJECT;
            } },
          }, async (_connection, candidates) => {
            if (candidates.includes('database-unavailable')) throw new Error('fixture unavailable');
            return candidates.includes('fixture-key');
          });
        } };` },
      ...pool.files,
    ], bindings: {
      POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/fixture",
      POOL_MANAGEMENT_KEY: "fixture-management", POOL_APP_SIGNING_KEY: "ab".repeat(32), POOL_IMAGE_HASH: "fixture",
    }, durableObjects: { POOL_OBJECT: { className: "SocketPool", useSQLite: true } }, serviceBindings: { ORIGIN: "origin" } },
    { ...compatibility, name: "origin", modules: true, script: origin },
  ] }));
  const sockets: any[] = [];
  try {
    const stats = async () => (await (await (await mf.getWorker("origin")).fetch("http://pool/stats")).json()).connections;
    for (const [headers, status] of [
      [{}, 401], [{ "X-Api-Key": "invalid" }, 401], [{ "X-Api-Key": "database-unavailable" }, 503],
    ] as const) {
      const response = await mf.dispatchFetch("https://pool.example/v1/responses", { headers: { Upgrade: "websocket", ...headers } });
      assert.equal(response.status, status);
      assert.equal(response.webSocket, null);
      await response.body?.cancel();
    }
    assert.equal(await stats(), 0, "refused upgrades must not reach the container");
    for (let i = 0; i < 2; i++) {
      const response = await mf.dispatchFetch(`https://pool.example/v1/responses?session=${i}`, { headers: {
        Upgrade: "websocket", Authorization: "Bearer unrelated-codex-login", "X-Api-Key": "fixture-key",
        "OpenAI-Beta": "responses_websockets=2026-02-06", "x-codex-turn-state": `turn-${i}`,
      } });
      assert.equal(response.status, 101);
      assert.equal(response.headers.get("x-codex-turn-state"), `turn-${i}`);
      const socket = response.webSocket;
      assert.ok(socket);
      sockets.push(socket);
      const handshake = message(socket);
      socket.accept();
      assert.deepEqual(JSON.parse(await handshake), {
        url: `http://pool/v1/responses?session=${i}`, method: "GET",
        authorization: "Bearer unrelated-codex-login", key: "fixture-key", beta: "responses_websockets=2026-02-06",
      });
    }
    // Interleave sessions and opaque control frames. The proxy must not parse or buffer them.
    for (const frame of ['{"type":"response.create","model":"fixture"}', '{"type":"response.interrupt","response_id":"fixture"}']) {
      const received = sockets.map(message);
      sockets.forEach((socket, i) => socket.send(`${frame} ${i}`));
      assert.deepEqual(await Promise.all(received), [0, 1].map((i) => `${frame} ${i}`));
    }
    const binary = message(sockets[0]);
    sockets[0].send(new Uint8Array([0, 255, 42]));
    assert.deepEqual(new Uint8Array(await binary), new Uint8Array([0, 255, 42]));
    const closed = new Promise<any>((resolve) => sockets[0].addEventListener("close", resolve, { once: true }));
    sockets[0].close(1000, "done");
    assert.equal((await closed).code, 1000);
    assert.equal(await stats(), 2);
  } finally {
    for (const socket of sockets) if (socket.readyState < 2) socket.close(1000, "cleanup");
    await mf.dispose();
  }
});

function message(socket: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", received);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
    };
    const received = (event: any) => { cleanup(); resolve(event.data); };
    const failed = () => { cleanup(); reject(new Error("WebSocket closed before the expected frame")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("WebSocket frame timed out")); }, 5_000);
    socket.addEventListener("message", received, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
  });
}
