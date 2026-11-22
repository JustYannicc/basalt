import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";

// The front layer's resend copy is kept only for a body of known size. A model call's size has to
// reach the hop that owns the container: entry, controller object, then a runtime's object, each
// rebuilding the request the way the pool does (new headers, container origin).
const fixture = `
import { DurableObject } from "cloudflare:workers";
const seen = (request) => request.headers.get("content-length");
const rebuilt = (request) => {
  const headers = new Headers(request.headers);
  headers.set("X-Basalt-Resumable", "1");
  const forwarded = new Request(request, { headers });
  return new Request(new URL(new URL(forwarded.url).pathname, "http://pool"), forwarded);
};
export class Controller extends DurableObject {
  async fetch(request) {
    const atController = seen(request);
    const answer = await this.env.RUNTIME.get(this.env.RUNTIME.idFromName("runtime")).fetch(rebuilt(request));
    return Response.json({ atController, ...(await answer.json()) });
  }
}
export class Runtime extends DurableObject {
  async fetch(request) {
    // As the layer hop does: the copy first, then the routed request that carries the body.
    const copy = request.clone();
    const routed = rebuilt(request);
    const bytes = (await routed.arrayBuffer()).byteLength;
    await copy.body?.cancel();
    return Response.json({ atRuntime: seen(routed), atCopy: seen(copy), bytes });
  }
}
export default {
  fetch(request, env) {
    return env.CONTROLLER.get(env.CONTROLLER.idFromName("controller")).fetch(request);
  },
};
`;

test(
  "a model call's Content-Length survives the entry, the controller and a runtime object",
  { timeout: 60_000 },
  async (context) => {
    const bundle = await build({
      stdin: { contents: fixture, loader: "js" },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      external: ["cloudflare:workers"],
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
      atController: String(size),
      atRuntime: String(size),
      atCopy: String(size),
      bytes: size,
    });

    // A streamed body has no size to keep a copy by, so no copy is kept and nothing is re-sent.
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
    const unsized = (await streamed.json()) as { atRuntime: string | null; bytes: number };
    assert.equal(unsized.atRuntime, null);
    assert.equal(unsized.bytes, 1024);
  },
);
