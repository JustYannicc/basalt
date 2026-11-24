import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { poolWorkerCompatibility } from "./worker-compatibility.ts";

// With the pool Worker's own settings, a controller instance that ends mid-call is a caller that
// left. A cell's control action must still run to its end; a model call it forwards must see it.
const fixture = `
import { DurableObject } from "cloudflare:workers";
import { runtimeCallerSignal } from "./src/pool/runtime-slots/transport.ts";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function note(storage, key, value) {
  await storage.put("seen", { ...((await storage.get("seen")) ?? {}), [key]: value });
}
export class Cell extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/seen")
      return Response.json((await this.ctx.storage.get("seen")) ?? {});
    request = runtimeCallerSignal(request);
    const kind = request.headers.has("X-Signalbox-Runtime-Identity") ? "model" : "control";
    const storage = this.ctx.storage;
    await note(storage, kind, "started");
    // The controller instance ends now, with this action under way.
    await this.env.CONTROLLER.get(this.env.CONTROLLER.idFromName("control")).fetch("http://pool/reset");
    let copy;
    if (kind === "model") {
      // As the endpoint does: the container send takes a copy of the request it was given.
      copy = new Request(request, { headers: { "x-hop": "container" } });
      void this.env.CONTAINER.get(this.env.CONTAINER.idFromName("c")).fetch(copy).catch(() => {});
    }
    // A multi-step action reads the signal between its steps, as the runtime's actions do.
    await wait(400);
    if (request.signal.aborted) {
      if (kind === "model") await note(storage, "copy", copy.signal.aborted ? "aborted" : "live");
      await note(storage, kind, "stopped");
      return new Response(null, { status: 499 });
    }
    await note(storage, kind, "finished");
    return new Response("done");
  }
}
export class Container extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/seen")
      return Response.json((await this.ctx.storage.get("seen")) ?? {});
    request.signal.addEventListener("abort", () => void note(this.ctx.storage, "container", "stopped"));
    await wait(1_000);
    if (!request.signal.aborted) await note(this.ctx.storage, "container", "finished");
    return new Response("{}");
  }
}
export class Controller extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/reset") {
      setTimeout(() => this.ctx.abort("replaced"), 0);
      return new Response(null, { status: 204 });
    }
    return this.env.CELL.get(this.env.CELL.idFromName("cell")).fetch(request);
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/seen") {
      const cell = await env.CELL.get(env.CELL.idFromName("cell")).fetch(request).then((r) => r.json());
      const container = await env.CONTAINER.get(env.CONTAINER.idFromName("c")).fetch(request).then((r) => r.json()).catch(() => ({}));
      return Response.json({ ...cell, ...container });
    }
    return env.CONTROLLER.get(env.CONTROLLER.idFromName("control")).fetch(request);
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
      durableObjects: {
        CELL: { className: "Cell", useSQLite: true },
        CONTAINER: { className: "Container", useSQLite: true },
        CONTROLLER: { className: "Controller", useSQLite: true },
      },
      outboundService: () => new Response(null, { status: 403 }),
    }),
  );
}

async function controllerReplacedDuring(headers: Record<string, string>) {
  const mf = await worker();
  try {
    await mf
      .dispatchFetch("http://pool/v1/messages", { method: "POST", body: "{}", headers })
      .then((response: Response) => response.text())
      .catch(() => "cut");
    // Past the cell's 400 ms step and the container's 1 s answer.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return (await (await mf.dispatchFetch("http://pool/seen")).json()) as Record<string, string>;
  } finally {
    await mf.dispose();
  }
}

test(
  "a cell's control action runs to its end when the controller instance that sent it ends",
  { timeout: 60_000 },
  async () => {
    assert.deepEqual(await controllerReplacedDuring({}), { control: "finished" });
  },
);

test(
  "a model call the cell forwards sees its controller leave, while its container send runs on",
  { timeout: 60_000 },
  async () => {
    // A copy keeps the signal, but without request_signal_passthrough a subrequest is not cancelled
    // by it: the container finishes the call, and only the cell's count lets go of it.
    assert.deepEqual(
      await controllerReplacedDuring({
        "X-Signalbox-Runtime-Identity": "{}",
        "X-Signalbox-Runtime-Port": "8317",
      }),
      { model: "stopped", copy: "aborted", container: "finished" },
    );
  },
);
