import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { Effect, Schema } from "effect";
import {
  compilerCacheRelease,
  compilerPreviewAcceptance,
} from "../../.upstream/apps/hosted/cloud/src/implementation/compiler-cache-config.ts";

// These proofs read the framework bytes scripts/build.ts compiles first, and only it runs them.
assert.equal(
  process.env.BASALT_CHECK_BUILT_FRAMEWORK,
  "1",
  "Run through scripts/build.ts, which builds the framework these proofs read",
);

const qualified = {
  stage: "test-pr-42",
  release: "a".repeat(40),
  registry: undefined,
  framework: "/reviewed/framework",
  expectedFramework: "/reviewed/framework",
  version: "0.0.1-beta.104-basalt.16",
  expectedVersion: "0.0.1-beta.104-basalt.16",
  acceptance: "true",
};

test("only an explicit, qualified PR preview can request cold compiler acceptance", () => {
  const accepted = compilerPreviewAcceptance(qualified);
  assert.deepEqual(accepted, {
    release: qualified.release,
    namespace: `executor-preview-compiler-acceptance-v1/test-pr-42/${qualified.release}`,
  });
  for (const override of [
    { acceptance: undefined },
    { acceptance: "false" },
    { acceptance: "1" },
    { stage: "production" },
    { stage: "dev" },
    { stage: "test-pr-0" },
    { stage: "test-pr-42/production" },
    { release: undefined },
    { release: "main" },
    { registry: "https://registry.invalid" },
    { framework: undefined },
    { expectedFramework: "/other/framework" },
    { version: undefined },
    { expectedVersion: "other" },
  ]) {
    assert.equal(compilerPreviewAcceptance({ ...qualified, ...override }), undefined);
  }
  assert.equal(compilerCacheRelease(qualified), undefined);
  assert.equal(compilerCacheRelease({ ...qualified, stage: "production" }), qualified.release);
  assert.equal(
    compilerCacheRelease({ ...qualified, stage: "production", registry: "custom" }),
    undefined,
  );
});

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare, Response: WorkerResponse } = require("miniflare") as typeof import("miniflare");

const worker = `
import { ConfigProvider, Effect } from "effect";
import { compilerCacheConfiguration } from "./apps/hosted/cloud/src/implementation/compiler-cache-config.ts";
import { compilerRuntime } from "./apps/hosted/cloud/src/implementation/compiler-runtime.ts";

export default {
  async fetch(request, env) {
    const input = await request.json();
    const counters = { names: [], lookups: 0, hits: 0, writes: 0 };
    const open = caches.open.bind(caches);
    Object.defineProperty(caches, "open", { configurable: true, value: async name => {
      counters.names.push(name);
      if (input.cacheUnavailable) throw new Error("Synthetic cache-open failure");
      const cache = await open(input.reuse ? "executor-private-compiler-results-v2" : name);
      return {
        match: async key => {
          counters.lookups++;
          if (input.fault === "lookup-unavailable") throw new Error("Synthetic cache lookup failure");
          if (input.fault === "lookup-timeout") return new Promise(() => {});
          if (input.fault === "corrupt-hit" || input.fault === "oversized-hit") {
            counters.hits++;
            return new Response(input.fault === "corrupt-hit" ? "corrupt" : "x".repeat(8 * 1024 * 1024));
          }
          const found = await cache.match(key); if (found) counters.hits++; return found;
        },
        put: async (key, value) => { counters.writes++; return cache.put(key, value); },
      };
    }});
    try {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const configured = yield* compilerCacheConfiguration(input.stage);
        const release = configured.release ?? configured.acceptance?.release;
        const runtime = yield* compilerRuntime({
          ASSETS: env.ASSETS,
          EXECUTOR_COMPILER_CACHE_ENABLED: String(release !== undefined),
          ...(configured.acceptance === undefined ? {} : {
            EXECUTOR_COMPILER_PREVIEW_CACHE_NAMESPACE: configured.acceptance.namespace,
          }),
        });
        return yield* runtime.compile(input.files, [], {});
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(input.config))));
      return Response.json({ ok: result.ok, error: result.ok ? null : result.error._tag, counters });
    } finally {
      Object.defineProperty(caches, "open", { configurable: true, value: open });
    }
  },
};`;

describe("native preview compiles stay cold while production reuse and normal previews keep their behavior", () => {
  let compiler: InstanceType<typeof Miniflare> | undefined;

  // One native compiler Worker serves every scenario below; building it is the slow part.
  before(async () => {
    const wasm = new Map<string, Buffer>();
    const bundle = await build({
      stdin: {
        contents: worker,
        sourcefile: "compiler-preview.ts",
        resolveDir: upstream,
        loader: "ts",
      },
      absWorkingDir: upstream,
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      conditions: ["workerd"],
      external: ["cloudflare:*"],
      logLevel: "silent",
      plugins: [
        {
          name: "compiler-wasm",
          setup(builder) {
            builder.onResolve({ filter: /\.wasm$/ }, (args) => {
              const path = args.path.startsWith(".")
                ? resolve(args.resolveDir, args.path)
                : createRequire(resolve(args.resolveDir, "wasm-resolution.mjs")).resolve(args.path);
              const name = `compiler-${wasm.size}.wasm`;
              wasm.set(name, readFileSync(path));
              return { path: `./${name}`, external: true };
            });
          },
        },
      ],
    });
    const framework = readFileSync(
      resolve(upstream, ".local/basalt-framework/framework.json"),
      "utf8",
    );
    compiler = new Miniflare({
      modules: [
        { type: "ESModule", path: "compiler.mjs", contents: bundle.outputFiles[0]!.text },
        ...Array.from(wasm, ([path, contents]) => ({
          type: "CompiledWasm" as const,
          path,
          contents,
        })),
      ],
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat", "no_brotli_content_encoding"],
      cachePersist: false,
      serviceBindings: { ASSETS: () => new WorkerResponse(framework) },
    });
    await compiler.ready;
  });

  after(() => compiler?.dispose());

  const decode = Schema.decodeUnknownEffect(
    Schema.Struct({
      ok: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
      counters: Schema.Struct({
        names: Schema.Array(Schema.String),
        lookups: Schema.Number,
        hits: Schema.Number,
        writes: Schema.Number,
      }),
    }),
  );
  const compile = async (
    stage: string,
    acceptance?: string,
    fault?:
      | "cache-unavailable"
      | "nonexact"
      | "reuse"
      | "lookup-unavailable"
      | "lookup-timeout"
      | "corrupt-hit"
      | "oversized-hit",
    expectedOk = true,
  ) => {
    assert.ok(compiler, "The native compiler Worker must be running");
    const response = await compiler.dispatchFetch("https://compiler.test", {
      method: "POST",
      body: JSON.stringify({
        stage,
        fault,
        cacheUnavailable: fault === "cache-unavailable",
        reuse: fault === "reuse",
        config: {
          EXECUTOR_APPS_VERSION: qualified.version,
          EXECUTOR_APPS_FRAMEWORK: qualified.framework,
          EXECUTOR_COMPILER_CACHE_APPS_VERSION: qualified.version,
          EXECUTOR_COMPILER_CACHE_FRAMEWORK: qualified.framework,
          EXECUTOR_COMPILER_CACHE_RELEASE: qualified.release,
          ...(acceptance === undefined ? {} : { EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE: acceptance }),
        },
        files: [
          {
            path: "package.json",
            content: JSON.stringify({
              type: "module",
              dependencies: {
                apps: fault === "nonexact" ? `^${qualified.version}` : qualified.version,
              },
            }),
          },
          {
            path: "index.ts",
            content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const result = await Effect.runPromise(decode(await response.json()));
    assert.equal(result.ok, expectedOk);
    if (!expectedOk) assert.equal(result.error, "RuntimeBuildFailed");
    return result.counters;
  };

  test("an accepted PR preview compiles cold into its own release namespace, every time", async () => {
    const first = await compile("test-pr-42", "true");
    const second = await compile("test-pr-42", "true");
    for (const result of [first, second]) {
      assert.equal(result.lookups, 1);
      assert.equal(result.hits, 0);
      assert.equal(result.writes, 1);
      assert.equal(result.names.length, 1);
      assert.ok(
        result.names[0]!.startsWith(
          `executor-preview-compiler-acceptance-v1/test-pr-42/${qualified.release}/`,
        ),
      );
    }
    assert.notEqual(first.names[0], second.names[0]);
  });

  test("a normal preview uses no cache, and production reuses its own", async () => {
    assert.deepEqual(await compile("test-pr-42"), { names: [], lookups: 0, hits: 0, writes: 0 });
    const production = await compile("production", "true");
    assert.deepEqual(production.names, ["executor-private-compiler-results-v2"]);
    assert.equal(production.hits, 0);
    assert.equal((await compile("production")).hits, 1);
  });

  test("an accepted preview refuses a reused, failed, slow, corrupt or oversized cache answer", async () => {
    const reused = await compile("test-pr-42", "true", "reuse", false);
    assert.equal(reused.hits, 1);
    assert.equal(reused.writes, 0);
    for (const fault of [
      "lookup-unavailable",
      "lookup-timeout",
      "corrupt-hit",
      "oversized-hit",
    ] as const) {
      const refused = await compile("test-pr-42", "true", fault, false);
      assert.equal(refused.lookups, 1);
      assert.equal(refused.writes, 0);
      assert.equal((await compile("production", undefined, fault)).writes, 1);
    }
  });

  test("an unavailable cache or an inexact framework pin refuses acceptance and spares production", async () => {
    const unavailable = await compile("test-pr-42", "true", "cache-unavailable", false);
    assert.equal(unavailable.lookups, 0);
    assert.equal(unavailable.writes, 0);
    await compile("production", undefined, "cache-unavailable");
    const nonexact = await compile("test-pr-42", "true", "nonexact", false);
    assert.deepEqual(nonexact, { names: [], lookups: 0, hits: 0, writes: 0 });
  });
});
