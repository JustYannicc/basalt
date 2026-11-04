import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare } = require("miniflare") as typeof import("miniflare");

const worker = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { Clock, Effect } from "effect";
import { makeBuildAdmission } from "./apps/hosted/cloud/src/implementation/build-admission.ts";
import { CompilerRequest } from "./apps/hosted/cloud/src/implementation/compiler-request-target.ts";
const admission = makeBuildAdmission(1, "50 seconds");
const events = [];
export default class extends WorkerEntrypoint {
  request() {
    const peer = this.env.PEER;
    return new CompilerRequest((signal, id) => Effect.gen(function* () {
      if (id === "abandoned") signal.addEventListener("abort", () => { events.push({ id, phase: "aborted" }); });
      const clock = yield* Clock.Clock;
      const work = admission(Effect.succeed(id), phase => events.push({ id, phase }), signal);
      if (id !== "abandoned") return yield* work;
      return yield* work.pipe(Effect.provideService(Clock.Clock, {
        ...clock,
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        sleep: () => Effect.promise(() => fetch(peer + "/queued")).pipe(Effect.andThen(Effect.never)),
      }));
    }));
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/state") return Response.json(events);
    return new Response(await Effect.runPromise(admission(
      Effect.promise(() => fetch(this.env.PEER + "/held").then(() => "released"))
    )));
  }
}`;
const caller = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async fetch(request) {
    using ticket = await this.env.COMPILER.request();
    using run = await ticket.start(new URL(request.url).pathname === "/abandon" ? "abandoned" : "live");
    if (new URL(request.url).pathname === "/abandon") {
      run.result().catch(() => {});
      await fetch(this.env.PEER + "/queued-observed");
      return new Response("caller ended");
    }
    return new Response(await run.result());
  }
}`;

test(
  "native RPC disposal removes an abandoned FIFO head before its expiry",
  { timeout: 15000 },
  async (context) => {
    const held = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const compiled = await build({
      stdin: {
        contents: worker,
        resolveDir: upstream,
        sourcefile: "compiler-lifetime-worker.ts",
        loader: "ts",
      },
      absWorkingDir: upstream,
      nodePaths: [
        resolve(upstream, "packages/sdk/node_modules"),
        resolve(upstream, "node_modules"),
      ],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "esnext",
      external: ["cloudflare:workers"],
      logLevel: "silent",
    });
    const outboundService = async (request: Request) => {
      switch (new URL(request.url).pathname) {
        case "/held":
          held.resolve();
          await release.promise;
          break;
        case "/queued":
          queued.resolve();
          break;
        case "/queued-observed":
          await queued.promise;
          break;
      }
      return new Response("ready");
    };
    const mf = new Miniflare({
      workers: [
        {
          name: "caller",
          outboundService,
          modules: [{ type: "ESModule", path: "caller.mjs", contents: caller }],
          compatibilityDate: "2026-09-08",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { PEER: "https://lifetime.test" },
          serviceBindings: { COMPILER: "compiler" },
        },
        {
          name: "compiler",
          outboundService,
          modules: [
            { type: "ESModule", path: "compiler.mjs", contents: compiled.outputFiles[0]!.text },
          ],
          compatibilityDate: "2026-09-08",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { PEER: "https://lifetime.test" },
        },
      ],
    });
    const aborted = new Promise<never>((_, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    });
    const until = <A>(work: Promise<A>) => Promise.race([work, aborted]);
    try {
      const compiler = await mf.getWorker("compiler");
      const occupying = compiler.fetch("https://compiler.test/hold");
      await until(held.promise);
      const abandoned = await until(mf.dispatchFetch("https://caller.test/abandon"));
      assert.equal(await abandoned.text(), "caller ended");
      release.resolve();
      await until(occupying);
      const live = await until(mf.dispatchFetch("https://caller.test/live"));
      assert.equal(await live.text(), "live");
      const state = await (await compiler.fetch("https://compiler.test/state")).json();
      assert.deepEqual(state, [
        { id: "abandoned", phase: "aborted" },
        { id: "live", phase: "admitted" },
        { id: "live", phase: "released" },
      ]);
    } finally {
      release.resolve();
      await mf.dispose();
    }
  },
);
