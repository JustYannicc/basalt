import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../scripts/startup-profiler/profile.ts";
import { poolWorkerCompatibility } from "./pool/worker-compatibility.ts";

// Three real workerd runtimes. The container's front layer keeps an answer by request id and serves
// it from any offset; it outlives the pool, as a container outlives the object that owns it. The
// pool runs the real entry: the first instance is torn down mid-stream, as the platform replaced
// the pool Worker's isolate on 24 Nov, and a second one answers the router's resume. The router
// runs the real model forward. The client must read every byte exactly once.
const signingKey = "ab".repeat(32);
const frames = {
  messages: Array.from(
    { length: 12 },
    (_, index) =>
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part ${index} ✓"}}\n\n`,
  ).concat('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
  responses: Array.from(
    { length: 12 },
    (_, index) =>
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"part ${index} ✓"}\n\n`,
  ).concat('event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n'),
};

const layer = (whole: string) => `
const whole = new TextEncoder().encode(${JSON.stringify(whole)});
const frame = 64;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const from = Number(url.searchParams.get("from") ?? 0);
    let offset = from;
    // Slow enough that the first pool goes down mid-answer, as a long answer does.
    const body = new ReadableStream({
      async pull(controller) {
        if (offset >= whole.byteLength) return controller.close();
        await new Promise((resolve) => setTimeout(resolve, 40));
        controller.enqueue(whole.slice(offset, offset + frame));
        offset += frame;
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "X-Basalt-Resume": "v1",
        ...(url.pathname === "/resume" ? { "X-Basalt-Resume-From": String(from) } : {}),
      },
    });
  },
};`;

const pool = `
import { fetchController } from "./src/pool/controller-reset.ts";
import { routerResume, routerResumePath } from "./src/pool/router-resume.ts";
import { encodeResumeTarget } from "./src/pool/stream-resume.ts";
import { openRouterAttempt } from "./src/pool/router-attempt.ts";
const keys = { key: "${signingKey}" };
const controller = {
  async fetch(request) {
    const named = await openRouterAttempt(request, keys.key);
    const answer = await fetch("http://layer/stream");
    const headers = new Headers(answer.headers);
    headers.set("X-Request-Id", named.requestId);
    headers.set("X-Signalbox-Pool-Boot", "boot-a");
    headers.set("X-Basalt-Resume-Target", encodeResumeTarget({ kind: "primary" }));
    return new Response(answer.body, { status: 200, headers });
  },
  resume: (input) => fetch("http://layer/resume?from=" + input.from),
};
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === routerResumePath)
      return routerResume(request, keys, controller.resume);
    return fetchController(request, {
      controller: () => controller,
      env: {},
      defer: (work) => ctx.waitUntil(work),
      signing: keys,
    });
  },
};`;

const router = `
import { forwardModelCall } from "./src/model-replay.ts";
export default {
  fetch(request, env) {
    return forwardModelCall(request, { POOL_SERVICE: env.POOL_SERVICE, POOL_APP_SIGNING_KEY: "${signingKey}" });
  },
};`;

async function bundle(contents: string) {
  const result = await build({
    stdin: { contents, resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts" },
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
  return result.outputFiles[0]!.text;
}

for (const [shape, parts] of Object.entries(frames))
  test(
    `a ${shape} stream whose pool goes down mid-answer reaches the client whole through the router`,
    { timeout: 60_000 },
    async (context) => {
      const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
      const runtime = (script: string, extra: object) =>
        new Miniflare(
          convertV4MiniflareOptions({
            modules: true,
            script,
            compatibilityDate: poolWorkerCompatibility.date,
            compatibilityFlags: poolWorkerCompatibility.flags,
            ...extra,
          }),
        );
      const whole = parts.join("");
      const container = runtime(layer(whole), {});
      context.after(() => container.dispose());
      const layerUrl = await container.ready;
      const toLayer = async (request: Request) => {
        const url = new URL(request.url);
        return fetch(new URL(url.pathname + url.search, layerUrl));
      };
      const poolScript = await bundle(pool);
      const pools = [
        runtime(poolScript, { outboundService: toLayer }),
        runtime(poolScript, { outboundService: toLayer }),
      ];
      context.after(() => Promise.allSettled(pools.map((each) => each.dispose())));
      const origins = await Promise.all(pools.map((each) => each.ready));
      let current = 0;
      const sends: string[] = [];
      const front = runtime(await bundle(router), {
        serviceBindings: {
          POOL_SERVICE: async (request: Request) => {
            const url = new URL(request.url);
            sends.push(`${current}:${url.pathname}`);
            return fetch(new URL(url.pathname, origins[current]), {
              method: request.method,
              headers: request.headers,
              body: request.body,
              duplex: "half",
            } as RequestInit);
          },
        },
      });
      context.after(() => front.dispose());
      const response = await front.dispatchFetch("http://app.example/v1/messages", {
        method: "POST",
        body: "{}",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.has("X-Basalt-Router-Resume"), false);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const first = await reader.read();
      text += decoder.decode(first.value, { stream: true });
      // The first pool's runtime goes away with the answer under way; the next sends reach the second.
      current = 1;
      await pools[0]!.dispose();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      assert.equal(text, whole, "every byte exactly once, no gap and no repeat");
      assert.deepEqual(sends, ["0:/v1/messages", "1:/__basalt/router-resume/v1"]);
    },
  );
