import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { signEnvelope } from "../pool/token.ts";
import { routeAcquisitionPrefix } from "./acquisition-contract.ts";

const routeId = "rt_" + "a".repeat(26);
const strangerRoute = "rt_" + "z".repeat(26);

// Real workerd, real RouteGateway, RouteHost RPC and PoolRoutePeer relay; only the container is fake.
const fixture = `
import { DurableObject } from 'cloudflare:workers';
import { RouteGateway as Gateway, routeAcquisition } from './src/route/gateway.worker.ts';
import { PoolRoutePeer } from './src/route/pool-peer.worker.ts';
import { FakeGateway } from './src/route/test/gateway.ts';
const fakes = [];
const routed = (env) => ({ ...env, RouteGateway: env.WITHOUT_GATEWAY ? undefined : { jurisdiction: () => env.Gateways },
  PoolContainer: { jurisdiction: () => env.Controllers } });
export class Gateways extends Gateway {
  constructor(ctx, env) { const fake = new FakeGateway(); fakes.push(fake);
    Object.defineProperty(ctx, 'container', { value: fake }); super(ctx, routed(env)); }
}
export class Controllers extends DurableObject {
  async routeOwner({ routeId }) { return routeId === '${routeId}' ? 'org/org-1/user/person-1' : null; }
}
export class Peer extends PoolRoutePeer { constructor(ctx, env) { super(ctx, routed(env)); } }
export class BarePeer extends PoolRoutePeer { constructor(ctx, env) { super(ctx, { ...routed(env), RouteGateway: undefined }); } }
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/route/v1/acquisitions') return routeAcquisition(request, routed(env));
  if (url.pathname === '/approve') { fakes.at(-1).approve(); return new Response('ok'); }
  if (url.pathname === '/crash') { fakes.at(-1).crash(); return new Response('ok'); }
  if (url.pathname === '/starts') return Response.json(fakes.at(-1).starts);
  if (url.pathname.startsWith('/peer/') || url.pathname.startsWith('/bare/')) {
    const pool = env.Controllers.idFromName('pool').toString();
    const peer = url.pathname.startsWith('/bare/') ? ctx.exports.BarePeer : ctx.exports.Peer;
    const target = 'http://route-peer.internal/route/' + url.pathname.split('/')[2];
    return peer({ props: { pool } }).fetch(new Request(target, { headers: request.headers }));
  }
  if (url.pathname === '/direct') {
    const id = env.Gateways.idFromName('${routeId}');
    return env.Gateways.get(id).fetch('http://route-gateway.internal/anything');
  }
  return new Response(null, { status: 404 });
} };
`;

async function start() {
  const bundle = await build({
    stdin: { contents: fixture, resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "module", "import"],
    target: "es2023",
    external: ["node:*", "cloudflare:workers"],
  });
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        Gateways: { className: "Gateways", useSQLite: true },
        Controllers: { className: "Controllers", useSQLite: true },
      },
      bindings: { POOL_APP_SIGNING_KEY: "a".repeat(64) },
      outboundService: () => new Response(null, { status: 403 }),
    }),
  );
}

type Miniflare = Awaited<ReturnType<typeof start>>;
const saved = { organization: "org-1", account: "acct-1" };
async function host(mf: Miniflare, action: string, input: object) {
  const at = Date.now();
  const person = ["start", "status", "cancel"].includes(action)
    ? { owner: "org/org-1/user/person-1" }
    : saved;
  const envelope = await signEnvelope("a".repeat(64), routeAcquisitionPrefix, {
    routeId,
    at,
    expiresAt: at + 25_000,
    action,
    ...person,
    ...input,
  });
  const response = await mf.dispatchFetch("http://fixture/route/v1/acquisitions", {
    method: "POST",
    body: JSON.stringify({ envelope }),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function open(mf: Miniflare, path: string) {
  const response = await mf.dispatchFetch(`http://fixture${path}`, { headers: { Upgrade: "websocket" } });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const messages: unknown[] = [];
  let next: (() => void) | undefined;
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event: { code: number; reason: string }) => resolve(event)),
  );
  socket.addEventListener("message", (event: { data: unknown }) => {
    messages.push(event.data);
    next?.();
  });
  socket.accept();
  const read = async () => {
    while (!messages.length)
      await new Promise<void>((resolve) => {
        next = resolve;
      });
    return messages.shift();
  };
  return { socket, read, closed };
}

test("real workerd: signed acquisitions drive the gateway and the pool peer tunnels bytes", { timeout: 60_000 }, async () => {
  const mf = await start();
  try {
    const started = await host(mf, "start", { app: "tailscale" });
    assert.equal(started.url, "https://login.example.invalid/a/test");
    assert.deepEqual(await host(mf, "start", { app: "tailscale", owner: "org/org-1/user/person-2" }), {
      error: "route_not_permitted",
    });
    assert.deepEqual(await host(mf, "status", {}), { state: "waiting" });
    await mf.dispatchFetch("http://fixture/approve");
    assert.deepEqual(await host(mf, "status", {}), { state: "connected", tailnet: "example-tailnet" });
    const { reading } = (await host(mf, "select", { exitId: "n1", whenDown: "stop" })) as {
      reading: Record<string, unknown>;
    };
    assert.equal(reading.state, "active");
    assert.equal(reading.exitName, "home-exit");
    assert.equal(reading.tailnet, "example-tailnet");
    assert.deepEqual(await host(mf, "reading", { account: "acct-2" }), { error: "route_not_permitted" });
    assert.deepEqual((await host(mf, "exits", {})).exits, [{ id: "n1", name: "home-exit", online: true }]);

    // The relay wire is the Home peer's, end to end, over the gateway's SOCKS port (an echo here).
    const tunnel = await open(mf, `/peer/${routeId}`);
    assert.deepEqual(JSON.parse(String(await tunnel.read())), { credit: 65_536 });
    tunnel.socket.send(JSON.stringify({ credit: 65_536 }));
    const bytes = new Uint8Array([5, 1, 0, 255, 42]);
    tunnel.socket.send(bytes);
    let reply: unknown;
    do reply = await tunnel.read();
    while (typeof reply === "string");
    assert.deepEqual(new Uint8Array(reply as ArrayBuffer), bytes);
    tunnel.socket.send(JSON.stringify({ fin: true }));
    assert.equal((await tunnel.closed).code, 1000);

    // A route this pool never assigned, and a pool without the class, are refused by close code.
    const stranger = await open(mf, `/peer/${strangerRoute}`);
    const refusal = await stranger.closed;
    assert.deepEqual([refusal.code, refusal.reason], [1008, "route_not_permitted"]);
    const bare = await open(mf, `/bare/${routeId}`);
    assert.equal((await bare.closed).code, 1013);
    assert.equal(
      (await mf.dispatchFetch("http://fixture/peer/not-a-route", { headers: { Upgrade: "websocket" } })).status,
      403,
    );
    // Everything but the private tunnel waits for slice 2.
    assert.equal((await mf.dispatchFetch("http://fixture/direct")).status, 501);

    // A restarted container gets the sealed identity back without a new approval.
    await mf.dispatchFetch("http://fixture/crash");
    assert.equal(((await host(mf, "reading", {})).reading as { state: string }).state, "active");
    assert.deepEqual(await (await mf.dispatchFetch("http://fixture/starts")).json(), [
      null,
      "node-state-after-login",
    ]);
    assert.deepEqual(await host(mf, "remove", {}), {});
    assert.equal(((await host(mf, "reading", {})).reading as { state: string }).state, "needs_login");
  } finally {
    await mf.dispose();
  }
});
