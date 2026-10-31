import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");

test("a real Worker WebSocket relay closes both sides when runtime protection fails after upgrade", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { NativeStreams } from "./src/pool/native-streams.ts";
        import { RuntimeProtection } from "./src/pool/runtime-protection.ts";
        import { PoolRuntimeUnhealthy } from "./src/pool/lifecycle.ts";
        import { nativeResponse } from "./src/pool/native-response.worker.ts";
        let healthy = true, upstreamClosed = false, observeClose;
        const upstreamDone = new Promise((resolve) => { observeClose = resolve; });
        const streams = new NativeStreams();
        let protection;
        export default { fetch(request, env, ctx) {
          const path = new URL(request.url).pathname;
          if (path === "/disable") { healthy = false; return new Response(null, { status: 204 }); }
          if (path === "/upstream-state") return upstreamDone.then(() => Response.json({ upstreamClosed }));
          if (path !== "/socket") return new Response(null, { status: 404 });
          const pair = new WebSocketPair();
          pair[1].accept();
          pair[1].addEventListener("close", () => { upstreamClosed = true; observeClose(); });
          const lease = streams.acquire("fixture", "pool", request.signal);
          protection ??= new RuntimeProtection(streams, {
            check: async () => {
              if (!healthy) throw new PoolRuntimeUnhealthy();
              return { boot_id: "boot", started_at: "fixture", policyLeaseUntil: performance.now() + 1500 };
            }, defer: (work) => ctx.waitUntil(work), unavailable: () => {},
          });
          protection.admit({ boot_id: "boot", started_at: "fixture", policyLeaseUntil: performance.now() + 1500 });
          return nativeResponse(new Response(null, { status: 101, webSocket: pair[0] }), lease);
        } };`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts", sourcefile: "runtime-protection-proof.ts",
    }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2023",
  });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"] });
  try {
    const response = await mf.dispatchFetch("https://fixture/socket", { headers: { Upgrade: "websocket" } });
    assert.equal(response.status, 101);
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<void>((resolve) => { socket.addEventListener("close", () => resolve(), { once: true }); });
    assert.equal((await mf.dispatchFetch("https://fixture/disable", { method: "POST" })).status, 204);
    await closed;
    const state = await (await mf.dispatchFetch("https://fixture/upstream-state")).json() as { upstreamClosed: boolean };
    assert.equal(state.upstreamClosed, true);
  } finally { await mf.dispose(); }
});
