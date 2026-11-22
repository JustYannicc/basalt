import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as post, type IncomingHttpHeaders } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { controllerHoldBytes } from "./controller-reset.ts";

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

/**
 * Sends a streamed body the way a full-duplex client does: the answer counts once it arrives, and
 * the upload stops there. Miniflare's dispatchFetch surfaces an answer only after the whole upload,
 * so a refusal the worker sends before reading the body raced workerd closing the connection and
 * failed as EPIPE on a busy runner (#1685).
 */
function sendEarly(origin: URL, path: string, body: ReadableStream<Uint8Array>) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>(
    (resolve, reject) => {
      let answered = false;
      const answer = Promise.withResolvers<void>();
      const request = post(new URL(path, origin), { method: "POST" }, (response) => {
        answered = true;
        answer.resolve();
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text }),
        );
        response.on("error", reject);
      });
      // Once answered, the rest of the upload may be refused; before that, a failure is real.
      request.on("error", (error) => (answered ? undefined : reject(error)));
      void (async () => {
        const reader = body.getReader();
        while (!answered) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!request.write(value))
            await Promise.race([
              new Promise((drained) => request.once("drain", drained)),
              answer.promise,
            ]);
        }
        void reader.cancel().catch(() => {});
        request.end();
      })().catch(reject);
    },
  );
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
    // Last: this answer leaves part of its upload unread, so workerd closes the connection, and a
    // call sent after it could start on that closing socket and fail with EPIPE.
    // Just over the hold bound: the worker refuses before it reads the whole body.
    const large = streamed(controllerHoldBytes + 256 * 1024);
    const advised = await sendEarly(await mf.ready, "/v1/messages", large.body);
    assert.equal(advised.status, 503, advised.text);
    assert.equal(advised.headers["retry-after"], "1");
    assert.equal(JSON.parse(advised.text).error.type, "api_error");
  },
);
