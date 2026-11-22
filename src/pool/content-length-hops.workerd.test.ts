import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";

// The front layer's resend copy is kept only for a body of known size. Here a model call crosses
// the hops the pool's own way: the entry keeps a copy for its replay, the controller object rebuilds
// the call and the fleet's retry keeps a backup before the send, and the runtime object runs the
// real layer hop. The layer refuses the connect, so the call must reach the node's port whole.
const fixture = `
import { DurableObject } from "cloudflare:workers";
import { toLayer } from "./src/pool/stream-resume.ts";
const rebuilt = (request) => {
  const headers = new Headers(request.headers);
  headers.set("X-Basalt-Resumable", "1");
  return new Request(new URL(new URL(request.url).pathname, "http://pool"), new Request(request, { headers }));
};
export class Controller extends DurableObject {
  async fetch(request) {
    const backup = request.clone();
    const answer = await this.env.RUNTIME.get(this.env.RUNTIME.idFromName("runtime")).fetch(rebuilt(request));
    await backup.body?.cancel();
    return answer;
  }
}
export class Runtime extends DurableObject {
  async fetch(request) {
    const ports = [];
    const answer = await toLayer(rebuilt(request), async (routed, port) => {
      ports.push(port);
      if (port === 8316) throw new Error("The container is not listening in the TCP address 10.0.0.1:8316");
      return Response.json({ length: routed.headers.get("content-length"), bytes: (await routed.arrayBuffer()).byteLength });
    });
    return Response.json({ ports, ...(await answer.json()) });
  }
}
export default {
  async fetch(request, env) {
    const held = request.clone();
    const answer = await env.CONTROLLER.get(env.CONTROLLER.idFromName("controller")).fetch(request);
    await held.body?.cancel();
    return answer;
  },
};
`;

test(
  "a model call's size reaches the layer hop through the pool's copies, so a refused connect re-sends it whole",
  { timeout: 60_000 },
  async (context) => {
    const bundle = await build({
      stdin: {
        contents: fixture,
        resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
        loader: "js",
      },
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
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0]!.text,
        compatibilityDate: "2026-09-08",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          CONTROLLER: { className: "Controller", useSQLite: true },
          RUNTIME: { className: "Runtime", useSQLite: true },
        },
        outboundService: () => new Response(null, { status: 403 }),
      }),
    );
    context.after(() => mf.dispose());
    const size = 256 * 1024;
    const known = await mf.dispatchFetch("http://pool/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(size).fill(97),
    });
    assert.deepEqual(await known.json(), {
      ports: [8316, 8317],
      length: String(size),
      bytes: size,
    });

    // A streamed body has no size, so no copy is kept: the refused connect is the layer's failure.
    const streamed = await mf.dispatchFetch("http://pool/v1/messages", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024).fill(98));
          controller.close();
        },
      }),
      duplex: "half",
    });
    assert.equal(streamed.status, 500);
    await streamed.body?.cancel();
  },
);
