import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { poolWorkerCompatibility } from "./worker-compatibility.ts";

// With the pool Worker's own settings, a Request that carries an AbortSignal can't cross an RPC
// call into a Durable Object: the call throws before the object runs, as the PoolOperations
// entrypoint's did after the controller-reset release.
const fixture = `
import { DurableObject } from "cloudflare:workers";
import { throughController } from "./src/pool/operations-call.ts";
export class Controller extends DurableObject {
  async runtimeHandoff(request) {
    return new Response(await request.text());
  }
}
export default {
  async fetch(request, env) {
    const lines = [];
    const signal = new URL(request.url).searchParams.has("signal") ? new AbortController().signal : null;
    const passed = new Request("http://pool/runtime-handoff", { method: "POST", body: "answered", signal });
    const controller = env.CONTROLLER.get(env.CONTROLLER.idFromName("control"));
    const response = await throughController(
      "/runtime-handoff",
      () => controller.runtimeHandoff(passed),
      (marker, line) => lines.push(marker + " " + line),
    );
    return Response.json({ status: response.status, body: await response.text(), lines });
  },
};
`;

async function worker() {
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
  });
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: poolWorkerCompatibility.date,
      compatibilityFlags: poolWorkerCompatibility.flags,
      durableObjects: { CONTROLLER: { className: "Controller", useSQLite: true } },
      outboundService: () => new Response(null, { status: 403 }),
    }),
  );
}

test(
  "a call into the controller that throws before it runs writes one closed line and answers 500",
  { timeout: 60_000 },
  async () => {
    const mf = await worker();
    try {
      const failed = await (await mf.dispatchFetch("http://pool/?signal")).json();
      assert.deepEqual(failed, {
        status: 500,
        body: "",
        lines: [
          'POOL_OPERATIONS_CALL_FAILED {"route":"/runtime-handoff","error":"DataCloneError","status":500}',
        ],
      });
      // The same call without the signal reaches the controller, and writes nothing.
      const answered = await (await mf.dispatchFetch("http://pool/")).json();
      assert.deepEqual(answered, { status: 200, body: "answered", lines: [] });
    } finally {
      await mf.dispose();
    }
  },
);
