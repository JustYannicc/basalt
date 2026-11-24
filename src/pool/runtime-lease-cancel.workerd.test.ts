import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { poolWorkerCompatibility } from "./worker-compatibility.ts";

// A cell admits a model call as the runtime endpoint does: a lease in its durable activity row,
// released by the native stream wrapper when the answer ends or the caller's signal aborts. Then
// the platform replaces an isolate mid-call, as it did on 24 Nov at 03:14Z, when six such leases
// stayed counted and the cell never idled out. The count must return to zero.
const fixture = `
import { DurableObject } from "cloudflare:workers";
import { RuntimeActivity } from "./src/pool/runtime-slots/activity.ts";
import { nativeResponse } from "./src/pool/native-response.worker.ts";
const identity = {
  format: "pool-runtime-slot-v1",
  controllerId: "controller-a",
  slotId: "slot-a",
  applicationId: "application-a",
  applicationVersion: "1",
  instanceId: "instance-a",
  imageDigest: "sha256:" + "a".repeat(64),
  imageInput: "image-a",
  bootId: "boot-a",
};
export class Cell extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.activity = new RuntimeActivity(ctx.storage);
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/cell-reset") {
      setTimeout(() => this.ctx.abort("replaced"), 0);
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/count") {
      // As the cell's count read does: settle what this instance can, then read.
      await this.activity.unproven(identity);
      const row = await this.activity.inspect(identity);
      return Response.json({ active: row?.active ?? 0 });
    }
    const done = await this.activity.acquire(identity, true);
    // The named instance ends now, with this call counted and its answer still to come.
    const reset = request.headers.get("x-reset");
    if (reset === "controller")
      await this.env.CONTROLLER.get(this.env.CONTROLLER.idFromName("control")).fetch("http://pool/reset");
    else if (reset === "cell") setTimeout(() => this.ctx.abort("replaced"), 0);
    const release = () => {
      this.ctx.waitUntil(done());
      return true;
    };
    // The container answers a non-streaming call whole, after its caller is gone.
    try {
      const answer = await this.env.UPSTREAM.get(this.env.UPSTREAM.idFromName("up")).fetch(request);
      return nativeResponse(answer, { signal: request.signal, release, onClose: () => {} });
    } catch (error) {
      release();
      throw error;
    }
  }
}
export class Upstream extends DurableObject {
  async fetch() {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  }
}
// The controller forwards to the cell; "/reset" ends its instance as the platform does.
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
    if (path === "/count" || path === "/cell-reset") return env.CELL.get(env.CELL.idFromName("cell")).fetch(request);
    return env.CONTROLLER.get(env.CONTROLLER.idFromName("control")).fetch(request);
  },
};
`;

async function cellWorker() {
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
        CONTROLLER: { className: "Controller", useSQLite: true },
        UPSTREAM: { className: "Upstream", useSQLite: true },
      },
      outboundService: () => new Response(null, { status: 403 }),
    }),
  );
}

async function countAfterReset(reset: "controller" | "cell") {
  const mf = await cellWorker();
  try {
    await mf
      .dispatchFetch("http://pool/v1/messages", {
        method: "POST",
        body: "{}",
        headers: { "x-reset": reset },
      })
      .then((response: Response) => response.status)
      .catch(() => "cut");
    // Past the container's answer and the release's own storage write.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const count = await mf.dispatchFetch("http://pool/count");
    return ((await count.json()) as { active: number }).active;
  } finally {
    await mf.dispose();
  }
}

test(
  "a cell's lease is released when the controller instance that called it is replaced",
  { timeout: 60_000 },
  async () => {
    assert.equal(await countAfterReset("controller"), 0);
  },
);

test(
  "a cell instance replaced mid-call does not keep that call counted",
  { timeout: 60_000 },
  async () => {
    // The lease is durable, but the call it counts died with the instance that held it.
    assert.equal(await countAfterReset("cell"), 0);
  },
);

// A lease of a replaced instance is over only for a call whose answer streams through that instance's
// own code. A model socket is the container's own, passed through untouched (the model-lifetime data
// path in endpoint.ts), and these two pin why only the first kind is stamped.
const passing = `
import { DurableObject } from "cloudflare:workers";
import { nativeResponse } from "./src/pool/native-response.worker.ts";
export class Container extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      let sent = 0;
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            controller.enqueue(new TextEncoder().encode("data: " + sent++ + "\\n\\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", () => server.send("pong"));
    return new Response(null, { status: 101, webSocket: client });
  }
}
export class Cell extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/cell-reset") {
      setTimeout(() => this.ctx.abort("replaced"), 0);
      return new Response(null, { status: 204 });
    }
    const answer = await this.env.CONTAINER.get(this.env.CONTAINER.idFromName("c")).fetch(request);
    if (answer.webSocket) return new Response(null, { status: 101, webSocket: answer.webSocket });
    return nativeResponse(answer, { signal: request.signal, release: () => true, onClose: () => {} });
  }
}
export default {
  fetch(request, env) {
    return env.CELL.get(env.CELL.idFromName("cell")).fetch(request);
  },
};
`;

async function passingWorker() {
  const bundle = await build({
    stdin: {
      contents: passing,
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
      },
    }),
  );
}

const settled = <T>(work: Promise<T>, fallback: T) =>
  Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 3_000))]);

test(
  "a streamed answer the cell wraps ends when its instance is replaced",
  { timeout: 60_000 },
  async () => {
    const mf = await passingWorker();
    try {
      const response = await mf.dispatchFetch("http://pool/v1/messages", {
        method: "POST",
        body: "{}",
      });
      const reader = response.body!.getReader();
      await reader.read();
      await mf.dispatchFetch("http://pool/cell-reset");
      const end = (async () => {
        try {
          for (;;) if ((await reader.read()).done) return "done";
        } catch {
          return "cut";
        }
      })();
      assert.equal(await settled(end, "still streaming"), "cut");
    } finally {
      await mf.dispose();
    }
  },
);

test(
  "a model socket through a cell instance that is replaced keeps running",
  { timeout: 60_000 },
  async () => {
    const mf = await passingWorker();
    try {
      const opened = await mf.dispatchFetch("http://pool/v1/responses", {
        headers: { Upgrade: "websocket" },
      });
      const socket = opened.webSocket!;
      socket.accept();
      const answer = () =>
        settled(
          new Promise<string>((resolve) =>
            socket.addEventListener("message", () => resolve("pong"), { once: true }),
          ),
          "silent",
        );
      const first = answer();
      socket.send("ping");
      assert.equal(await first, "pong");
      await mf.dispatchFetch("http://pool/cell-reset");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = answer();
      socket.send("ping");
      assert.equal(await after, "pong");
      socket.close();
    } finally {
      await mf.dispose();
    }
  },
);
