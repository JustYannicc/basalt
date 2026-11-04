import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare } = require("miniflare") as typeof import("miniflare");

const worker = `
import { createWorker } from "@cloudflare/worker-bundler";
import { Effect } from "effect";
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
      catch: error => error,
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
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};`;

const bundled = build({
  stdin: { contents: worker, resolveDir: upstream, sourcefile: "compiler-session-worker.ts" },
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
const within = async <A>(work: Promise<A>, message: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
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
  async () => {
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
          again.resolve();
          await releaseAgain.promise;
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
    const requests: Promise<unknown>[] = [];
    const evidence: Record<string, unknown> = {};
    try {
      await mf.ready;
      const owner = mf.dispatchFetch("https://compiler.test/?id=owner&abandon=1");
      requests.push(owner);
      await within(first.promise, "the owner's first bundle did not reach its input");
      const started = performance.now();
      const successor = mf.dispatchFetch("https://compiler.test/?id=successor");
      requests.push(successor);
      await within(admitted.promise, "the successor was not admitted beside the first owner");
      const before = await (await mf.dispatchFetch("https://compiler.test/state")).json();
      evidence.before = before;
      assert.ok(Array.isArray(before));
      assert.equal(before.filter((event) => event.phase === "admitted").length, 2);
      releaseFirst.resolve();
      await within(again.promise, "the owner did not start its next bundle");
      assert.equal((await owner).status, 200);
      releaseSuccessor.resolve();
      const response = await within(
        successor,
        "the admitted successor did not reply within 2 seconds while the owner's next bundle held its input",
      );
      const body = await response.text();
      evidence.successor = {
        status: response.status,
        elapsedMs: performance.now() - started,
        body,
      };
      assert.equal(response.status, 200, body);
      assert.ok(JSON.parse(body).bytes > 0);
      assert.ok(JSON.parse(body).bundle.includes(JSON.stringify("successor")));
      assert.ok(
        performance.now() - started < 2_000,
        "the successor must not wait for another request's 50-second lease",
      );
      evidence.after = await (await mf.dispatchFetch("https://compiler.test/state")).json();
    } finally {
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
            const body = (await response.json()) as { id: string; bytes: number; bundle: string };
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
