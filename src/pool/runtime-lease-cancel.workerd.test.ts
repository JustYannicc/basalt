import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";

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
      const row = await this.activity.inspect(identity);
      return Response.json({ active: row?.active ?? 0 });
    }
    const done = await this.activity.acquire(identity);
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

// The pool Worker's own settings (src/pool/deployment.ts).
const poolCompatibility = { date: "2026-09-08", flags: ["nodejs_compat"] };

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
      compatibilityDate: poolCompatibility.date,
      compatibilityFlags: poolCompatibility.flags,
      durableObjects: {
        CELL: { className: "Cell", useSQLite: true },
        CONTROLLER: { className: "Controller", useSQLite: true },
        UPSTREAM: { className: "Upstream", useSQLite: true },
      },
      outboundService: () => new Response(null, { status: 403 }),
    }),
  );
}

async function countAfterReset(reset: "/reset" | "/cell-reset") {
  const mf = await cellWorker();
  try {
    const call = mf
      .dispatchFetch("http://pool/v1/messages", { method: "POST", body: "{}" })
      .then((response) => response.status)
      .catch(() => "cut");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = await mf.dispatchFetch("http://pool/count");
    assert.deepEqual(await before.json(), { active: 1 }, "the call was never counted");
    await mf.dispatchFetch(`http://pool${reset}`);
    await call;
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
    assert.equal(await countAfterReset("/reset"), 0);
  },
);

test(
  "a cell instance replaced mid-call does not keep that call counted",
  { timeout: 60_000 },
  async () => {
    // The lease is durable, but the call it counts died with the instance that held it.
    assert.equal(await countAfterReset("/cell-reset"), 0);
  },
);
