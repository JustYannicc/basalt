import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

import { Miniflare } from "../pool-test-runtime/index.ts";

test("a Worker relay refuses unproven readiness, recovers admission and closes on a proven boot change", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { NativeStreams } from "./src/pool/native-streams.ts";
        import { RuntimeProtection } from "./src/pool/runtime-protection.ts";
        import { PoolRuntimeUnhealthy } from "./src/pool/lifecycle.ts";
        import { nativeResponse } from "./src/pool/native-response.worker.ts";
        import { modelLifetimeFetch } from "./src/pool/model-lifetime.worker.ts";
        export { ModelLifetimeNode } from "./scripts/pool-tests/model-lifetime-node.mjs";
        let healthy = true, boot = "boot", notifyDegraded = () => {};
        const streams = new NativeStreams();
        async function readiness(lease = "fresh") {
          if (!healthy) throw new PoolRuntimeUnhealthy();
          const remaining = { fresh: 1500, expired: -1, short: 100 }[lease];
          return { boot_id: boot, started_at: "fixture",
            ...(remaining === undefined ? {} : { policyLeaseUntil: performance.now() + remaining }) };
        }
        let protection;
        export class Relay {
          constructor(ctx, env) { this.ctx = ctx; this.env = env; }
          async fetch(request) {
          const url = new URL(request.url), path = url.pathname;
          const node = this.env.NODE.getByName("fixture");
          if (path === "/disable") { healthy = false; return new Response(null, { status: 204 }); }
          if (path === "/degraded") return Response.json({ upstreamClosed: (await (await node.fetch("https://node/node-state")).json()).closed });
          if (path === "/recover") { healthy = true; return new Response(null, { status: 204 }); }
          if (path === "/restart") { healthy = true; boot = "new-boot"; return new Response(null, { status: 204 }); }
          if (path === "/upstream-state") return node.fetch("https://node/node-wait-closed?count=2");
          if (path !== "/socket") return new Response(null, { status: 404 });
          const lease = streams.acquire("fixture", "pool", request.signal);
          protection ??= new RuntimeProtection(streams, {
            check: () => readiness(),
            defer: (work) => this.ctx.waitUntil(work), unavailable: (_count, diagnostic) => { if (diagnostic.action === "preserved") notifyDegraded(); },
          });
          try { protection.admit(await readiness(url.searchParams.get("lease") ?? "fresh")); }
          catch (error) {
            lease.release();
            if (!(error instanceof PoolRuntimeUnhealthy)) throw error;
            return new Response(null, { status: 503 });
          }
          notifyDegraded = () => this.ctx.waitUntil(node.fetch("https://node/node-broadcast", { method: "POST", body: "runtime-unhealthy" }));
          const response = await modelLifetimeFetch(new Request("https://node/socket", { headers: request.headers, signal: lease.signal }), (request) => node.fetch(request));
          return nativeResponse(response, lease);
        } }
        export default { fetch(request, env) { return env.RELAY.get(env.RELAY.idFromName("fixture")).fetch(request); } };`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "ts",
      sourcefile: "runtime-protection-proof.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare({
    modules: true,
    // A plain Worker cannot close I/O created by another request.
    durableObjects: { RELAY: "Relay", NODE: { className: "ModelLifetimeNode", useSQLite: true } },
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
  });
  try {
    const response = await mf.dispatchFetch("https://fixture/socket", {
      headers: { Upgrade: "websocket" },
    });
    assert.equal(response.status, 101);
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    const degraded = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    assert.equal(
      (await mf.dispatchFetch("https://fixture/disable", { method: "POST" })).status,
      204,
    );
    assert.equal(await degraded, "runtime-unhealthy");
    assert.deepEqual(await (await mf.dispatchFetch("https://fixture/degraded")).json(), {
      upstreamClosed: 0,
    });
    assert.equal(
      (await mf.dispatchFetch("https://fixture/socket", { headers: { Upgrade: "websocket" } }))
        .status,
      503,
    );
    const echoed = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    socket.send("still-streaming");
    assert.equal(await echoed, "still-streaming");
    assert.equal(
      (await mf.dispatchFetch("https://fixture/recover", { method: "POST" })).status,
      204,
    );
    for (const lease of ["missing", "expired", "short"])
      assert.equal(
        (
          await mf.dispatchFetch(`https://fixture/socket?lease=${lease}`, {
            headers: { Upgrade: "websocket" },
          })
        ).status,
        503,
        `${lease} readiness cannot admit new work`,
      );
    const recovered = await mf.dispatchFetch("https://fixture/socket", {
      headers: { Upgrade: "websocket" },
    });
    assert.equal(recovered.status, 101);
    const recoveredSocket = recovered.webSocket!;
    recoveredSocket.accept();
    const recoveredClosed = new Promise<void>((resolve) => {
      recoveredSocket.addEventListener("close", () => resolve(), { once: true });
    });
    const recoveredEcho = new Promise<string>((resolve) => {
      recoveredSocket.addEventListener("message", (event) => resolve(String(event.data)), {
        once: true,
      });
    });
    recoveredSocket.send("recovered-streaming");
    assert.equal(await recoveredEcho, "recovered-streaming");
    assert.deepEqual(await (await mf.dispatchFetch("https://fixture/degraded")).json(), {
      upstreamClosed: 0,
    });
    assert.equal(
      (await mf.dispatchFetch("https://fixture/restart", { method: "POST" })).status,
      204,
    );
    await Promise.all([closed, recoveredClosed]);
    const state = (await (await mf.dispatchFetch("https://fixture/upstream-state")).json()) as {
      upstreamClosed: number;
    };
    assert.equal(state.upstreamClosed, 2);
  } finally {
    await mf.dispose();
  }
});
