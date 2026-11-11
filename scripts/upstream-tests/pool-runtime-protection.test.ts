import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");

test("a Worker relay refuses unproven readiness, recovers admission and closes on a proven boot change", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { NativeStreams } from "./src/pool/native-streams.ts";
        import { RuntimeProtection } from "./src/pool/runtime-protection.ts";
        import { PoolRuntimeUnhealthy } from "./src/pool/lifecycle.ts";
        import { nativeResponse } from "./src/pool/native-response.worker.ts";
        let healthy = true, boot = "boot", upstreamClosed = 0, observeClose, notifyDegraded = () => {};
        const upstreamDone = new Promise((resolve) => { observeClose = resolve; });
        const streams = new NativeStreams();
        async function readiness(lease = "fresh") {
          if (!healthy) throw new PoolRuntimeUnhealthy();
          const remaining = { fresh: 1500, expired: -1, short: 100 }[lease];
          return { boot_id: boot, started_at: "fixture",
            ...(remaining === undefined ? {} : { policyLeaseUntil: performance.now() + remaining }) };
        }
        let protection;
        export class Relay {
          constructor(ctx) { this.ctx = ctx; }
          async fetch(request) {
          const url = new URL(request.url), path = url.pathname;
          if (path === "/disable") { healthy = false; return new Response(null, { status: 204 }); }
          if (path === "/degraded") return Response.json({ upstreamClosed });
          if (path === "/recover") { healthy = true; return new Response(null, { status: 204 }); }
          if (path === "/restart") { healthy = true; boot = "new-boot"; return new Response(null, { status: 204 }); }
          if (path === "/upstream-state") return upstreamDone.then(() => Response.json({ upstreamClosed }));
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
          const pair = new WebSocketPair();
          pair[1].accept();
          pair[1].addEventListener("close", () => { if (++upstreamClosed === 2) observeClose(); });
          pair[1].addEventListener("message", (event) => pair[1].send(event.data));
          notifyDegraded = () => pair[1].send("runtime-unhealthy");
          return nativeResponse(new Response(null, { status: 101, webSocket: pair[0] }), lease);
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
  });
  const mf = new Miniflare({
    modules: true,
    // A plain Worker cannot close I/O created by another request.
    durableObjects: { RELAY: "Relay" },
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
