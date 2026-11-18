import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";

// The first send reads part of a streamed body and fails as a replaced instance does; the replay
// must reach a real object with the whole body, through workerd's own clone and tee.
const fixture = `
import { DurableObject } from "cloudflare:workers";
import { fetchController } from "./src/pool/controller-reset.ts";
export class Echo extends DurableObject {
  async fetch(request) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Response.json({
      size: bytes.byteLength,
      digest: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    });
  }
}
export default {
  fetch(request, env, ctx) {
    let attempt = 0;
    const echo = () => env.ECHO.get(env.ECHO.idFromName("echo"));
    // With this header the first send is the real one, to prove the copy giving up never touches it.
    if (request.headers.has("x-send-first")) return fetchController(request, { controller: echo, env: {}, defer: (work) => ctx.waitUntil(work), wait: async () => {} });
    return fetchController(request, {
      controller: () =>
        ++attempt === 1
          ? {
              fetch: async (first) => {
                await first.body.getReader().read();
                throw Object.assign(
                  new Error("Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request."),
                  { retryable: true },
                );
              },
            }
          : env.ECHO.get(env.ECHO.idFromName("echo")),
      env: {},
      defer: (work) => ctx.waitUntil(work),
      wait: async () => {},
    });
  },
};
`;

function streamed(size: number) {
  const chunk = 64 * 1024;
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  let offset = 0;
  return {
    digest: createHash("sha256").update(bytes).digest("hex"),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= size) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + chunk));
        offset += chunk;
      },
    }),
  };
}

test(
  "real workerd holds a streamed model body beside the first send and replays it whole",
  { timeout: 60_000 },
  async (context) => {
    const bundle = await build({
      stdin: {
        contents: fixture,
        resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "module", "import"],
      target: "es2023",
      external: ["node:*", "cloudflare:workers"],
      plugins: [
        {
          name: "no-account-database",
          setup(build) {
            build.onResolve({ filter: /^pg$/ }, () => ({ path: "pg", namespace: "unavailable" }));
            build.onLoad({ filter: /.*/, namespace: "unavailable" }, () => ({
              contents:
                "export default { Pool: class { constructor(){ throw Error('No database'); } } };",
            }));
          },
        },
      ],
    });
    const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0]!.text,
        compatibilityDate: "2026-09-08",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { ECHO: { className: "Echo", useSQLite: true } },
        outboundService: () => new Response(null, { status: 403 }),
      }),
    );
    context.after(() => mf.dispose());
    const held = streamed(3 * 1024 * 1024);
    const replayed = await mf.dispatchFetch("http://pool/v1/messages", {
      method: "POST",
      body: held.body,
      duplex: "half",
    });
    assert.equal(replayed.status, 200);
    assert.deepEqual(await replayed.json(), { size: 3 * 1024 * 1024, digest: held.digest });
    const large = streamed(5 * 1024 * 1024);
    const advised = await mf.dispatchFetch("http://pool/v1/messages", {
      method: "POST",
      body: large.body,
      duplex: "half",
    });
    assert.equal(advised.status, 503);
    assert.equal(advised.headers.get("Retry-After"), "1");
    assert.equal((await advised.json()).error.type, "api_error");
    // The copy gives up past 4 MiB, midway through 64 KiB reads; the real send keeps every byte.
    const whole = streamed(5 * 1024 * 1024);
    const sent = await mf.dispatchFetch("http://pool/v1/messages", {
      method: "POST",
      headers: { "x-send-first": "1" },
      body: whole.body,
      duplex: "half",
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { size: 5 * 1024 * 1024, digest: whole.digest });
  },
);
