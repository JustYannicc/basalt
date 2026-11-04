import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { Schema } from "effect";

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare } = require("miniflare") as typeof import("miniflare");

const worker = `
import { createWorker } from "@cloudflare/worker-bundler";
import { Data, Effect } from "effect";
class FixtureCompileFailed extends Data.TaggedError("FixtureCompileFailed")<{ readonly cause: unknown }> {}
import { makeBuildAdmission } from "./apps/hosted/cloud/src/implementation/build-admission.ts";
import { compileWithinDeadline } from "./apps/hosted/cloud/src/implementation/compiler-request.ts";
const admission = makeBuildAdmission(2, "50 seconds");
const events = [];
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/state") return Response.json(events);
    const id = url.searchParams.get("id");
    const once = (pass) => Effect.tryPromise({
      try: (signal) => createWorker({
        signal,
        files: { "index.ts": "export default { fetch() { return new Response(" + JSON.stringify(id) + ") } }" },
        entryPoint: "index.ts",
        __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [{
          name: "request-owned-input",
          setup(build) {
            build.onStart(async () => {
              events.push({ id, phase: "bundle-start", pass });
              if (id === "owner" || id === "successor") {
                const path = id === "owner" ? (pass === 0 ? "/first" : "/again") : "/successor";
                await fetch(env.PEER + path).then(response => response.text());
              }
            });
          },
        }],
      }),
      catch: cause => new FixtureCompileFailed({ cause }),
    });
    const work = id === "owner" ? once(0).pipe(Effect.andThen(once(1))) : once(0);
    const pending = Effect.runPromise(admission(compileWithinDeadline(work), phase => {
      events.push({ id, phase });
      if (id === "successor" && phase === "admitted")
        void fetch(env.PEER + "/admitted").then(response => response.text());
    }));
    if (url.searchParams.has("abandon")) {
      pending.catch(() => {});
      await fetch(env.PEER + "/seen");
      return new Response("owner ended");
    }
    try {
      const result = await pending;
      return Response.json({ id, bytes: JSON.stringify(result.modules).length, bundle: result.modules[result.mainModule] });
    } catch {
      return new Response("Fixture compilation failed", { status: 500 });
    }
  },
};`;

const bundled = build({
  stdin: {
    contents: worker,
    resolveDir: upstream,
    sourcefile: "compiler-session-worker.ts",
    loader: "ts",
  },
  absWorkingDir: upstream,
  nodePaths: [resolve(upstream, "packages/sdk/node_modules"), resolve(upstream, "node_modules")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2023",
  logLevel: "silent",
  plugins: [
    {
      name: "compiled-wasm",
      setup(builder) {
        builder.onResolve({ filter: /esbuild\.wasm$/ }, () => ({
          path: "./esbuild.wasm",
          external: true,
        }));
      },
    },
  ],
});
const deferred = () => Promise.withResolvers<void>();
const BundleResponse = Schema.Struct({
  id: Schema.String,
  bytes: Schema.Number,
  bundle: Schema.String,
});
const decodeBundle = Schema.decodeUnknownSync(Schema.fromJsonString(BundleResponse));
const decodeEvents = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      phase: Schema.Literals(["admitted", "bundle-start", "released"]),
      pass: Schema.optional(Schema.Number),
    }),
  ),
);
const runtime = async (outboundService?: (request: Request) => Promise<Response>) => {
  const built = await bundled;
  return new Miniflare({
    modules: [
      { type: "ESModule", path: "compiler-session.mjs", contents: built.outputFiles[0]!.text },
      {
        type: "CompiledWasm",
        path: "esbuild.wasm",
        contents: readFileSync(
          resolve(
            upstream,
            "packages/sdk/node_modules/@cloudflare/worker-bundler/dist/esbuild.wasm",
          ),
        ),
      },
    ],
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { PEER: "https://compiler-input.test" },
    ...(outboundService === undefined ? {} : { outboundService }),
  });
};

test(
  "an admitted successor replies while an earlier request starts another bundle and ends",
  { timeout: 15_000 },
  async (context) => {
    let againHeld = false;
    const first = deferred(),
      again = deferred(),
      admitted = deferred();
    const releaseFirst = deferred(),
      releaseAgain = deferred(),
      releaseSuccessor = deferred();
    const mf = await runtime(async (request) => {
      switch (new URL(request.url).pathname) {
        case "/first":
          first.resolve();
          await releaseFirst.promise;
          break;
        case "/again":
          againHeld = true;
          again.resolve();
          await releaseAgain.promise;
          againHeld = false;
          break;
        case "/admitted":
          admitted.resolve();
          break;
        case "/seen":
          await again.promise;
          break;
        case "/successor":
          await releaseSuccessor.promise;
          break;
      }
      return new Response("ready");
    });
    let abort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(context.signal.reason);
      if (context.signal.aborted) abort();
      else context.signal.addEventListener("abort", abort, { once: true });
    });
    const until = <A>(work: Promise<A>) => Promise.race([work, cancelled]);
    const requests: Promise<unknown>[] = [];
    const evidence: Record<string, unknown> = {};
    try {
      await until(mf.ready);
      const owner = mf.dispatchFetch("https://compiler.test/?id=owner&abandon=1");
      requests.push(owner);
      await until(first.promise);
      const started = performance.now();
      const successor = mf.dispatchFetch("https://compiler.test/?id=successor");
      requests.push(successor);
      await until(admitted.promise);
      const before = decodeEvents(
        await until((await until(mf.dispatchFetch("https://compiler.test/state"))).json()),
      );
      evidence.before = before;
      assert.equal(before.filter((event) => event.phase === "admitted").length, 2);
      releaseFirst.resolve();
      await until(again.promise);
      assert.equal((await until(owner)).status, 200);
      releaseSuccessor.resolve();
      const response = await until(successor);
      const body = await until(response.text());
      evidence.successor = {
        status: response.status,
        elapsedMs: performance.now() - started,
        body,
      };
      assert.equal(response.status, 200, body);
      const decoded = decodeBundle(body);
      assert.ok(decoded.bytes > 0);
      assert.ok(decoded.bundle.includes(JSON.stringify("successor")));
      assert.equal(
        againHeld,
        true,
        "the successor must finish before the owner's next input is released",
      );
      evidence.againHeldAtSuccessorReply = againHeld;
      evidence.after = decodeEvents(
        await until((await until(mf.dispatchFetch("https://compiler.test/state"))).json()),
      );
    } finally {
      context.signal.removeEventListener("abort", abort);
      releaseFirst.resolve();
      releaseAgain.resolve();
      releaseSuccessor.resolve();
      if (process.env.COMPILER_SESSION_EVIDENCE)
        writeFileSync(
          process.env.COMPILER_SESSION_EVIDENCE,
          JSON.stringify(evidence, null, 2) + "\n",
        );
      const settled = Promise.allSettled(requests);
      await mf.dispose();
      await settled;
    }
  },
);

test(
  "concurrent admitted bundles keep independent WASM services across a warm isolate",
  { timeout: 15_000 },
  async () => {
    const mf = await runtime();
    try {
      await mf.ready;
      for (let wave = 0; wave < 3; wave++) {
        const responses = await Promise.all(
          Array.from({ length: 16 }, async (_, index) => {
            const id = `bundle-${wave}-${index}`;
            const response = await mf.dispatchFetch(`https://compiler.test/?id=${id}`);
            const body = decodeBundle(await response.text());
            assert.equal(response.status, 200);
            assert.equal(body.id, id);
            assert.ok(body.bytes > 0);
            assert.ok(body.bundle.includes(JSON.stringify(id)));
            return body;
          }),
        );
        assert.equal(responses.length, 16);
      }
    } finally {
      await mf.dispose();
    }
  },
);
