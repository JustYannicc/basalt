import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Schema } from "effect";
import { LoadedWorkerBuild } from "../../.upstream/packages/sdk/src/contracts/worker-build.ts";

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare } = require("miniflare") as typeof import("miniflare");

const compiler = `
import { Effect, Option } from "effect";
import { BlobStore } from "./packages/sdk/src/contracts/blobs.ts";
import { BuildId } from "./packages/sdk/src/contracts/shared.ts";
import { InlinedWorkerBuild } from "./packages/sdk/src/contracts/worker-build.ts";
import { compileWorkerApp } from "./packages/sdk/src/implementation/worker-build.ts";
import {
  assembleWorkerBundle, retainWorkerBuild, loadStoredWorkerBuild, loadWorkerFramework,
  linkWorkerBuild, encodeJson, inlinedBuildKey,
} from "./packages/sdk/src/implementation/worker-build-storage.ts";
export default {
  async fetch(request) {
    const input = await request.json();
    const objects = new Map();
    const blobs = {
      get: (key) => Effect.succeed(Option.fromNullishOr(objects.get(key))),
      exists: (key) => Effect.succeed(objects.has(key)),
      put: (key, body) => Effect.sync(() => { objects.set(key, body); }),
    };
    const result = Effect.gen(function* () {
      const compiled = yield* compileWorkerApp(input.files, {
        apps: { version: input.version, files: Effect.succeed(input.framework) },
      });
      const loaded = {
        ...assembleWorkerBundle(compiled.bundle, compiled.framework),
        protocol: compiled.protocol,
      };
      const build = BuildId.make("bld_public_compiler_fixture");
      yield* retainWorkerBuild(build, {
        ...compiled.bundle, database: false, protocol: compiled.protocol,
      }, compiled.framework, undefined);
      const stored = yield* loadStoredWorkerBuild(build);
      const split = yield* linkWorkerBuild(stored, (identity) => loadWorkerFramework(identity, build), build);
      const legacyBuild = BuildId.make("bld_public_inlined_fixture");
      yield* blobs.put(yield* inlinedBuildKey(legacyBuild), yield* encodeJson(InlinedWorkerBuild, {
        format: 1, ...loaded, database: false,
      }));
      const legacy = yield* loadStoredWorkerBuild(legacyBuild);
      const inlined = yield* linkWorkerBuild(legacy,
        () => Effect.die("An inlined build cannot load a split framework"), legacyBuild);
      return {
        loaded, split, inlined, storedFormat: stored.format, inlinedFormat: legacy.format,
        objectCount: objects.size,
      };
    }).pipe(
      Effect.provideService(BlobStore, blobs),
      Effect.match({ onSuccess: (value) => ({ ok: true, value }), onFailure: (error) => ({ ok: false, error }) }),
    );
    return Response.json(await Effect.runPromise(result));
  },
};`;

/** The real compiler and its WASM modules run in workerd, as they do in production. */
export async function compileFrameworkFixture(
  authored: string,
  extraFiles: readonly { readonly path: string; readonly content: string }[] = [],
) {
  const wasm = new Map<string, Buffer>();
  const bundled = await build({
    stdin: {
      contents: compiler,
      sourcefile: "public-compiler.ts",
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
  const framework = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
    JSON.parse(readFileSync(resolve(upstream, ".local/basalt-framework/framework.json"), "utf8")),
  );
  const { version } = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
    JSON.parse(framework["package.json"]!),
  );
  const runtime = new Miniflare({
    modules: [
      { type: "ESModule", path: "compiler.mjs", contents: bundled.outputFiles[0]!.text },
      ...Array.from(wasm, ([path, contents]) => ({
        type: "CompiledWasm" as const,
        path,
        contents,
      })),
    ],
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat", "no_brotli_content_encoding"],
  });
  try {
    const response = await runtime.dispatchFetch("https://compiler.test", {
      method: "POST",
      body: JSON.stringify({
        version,
        framework,
        files: [
          {
            path: "package.json",
            content: JSON.stringify({ type: "module", dependencies: { apps: version } }),
          },
          { path: "index.ts", content: authored },
          ...extraFiles,
        ],
      }),
    });
    assert.equal(response.status, 200);
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        ok: Schema.Literal(true),
        value: Schema.Struct({
          loaded: LoadedWorkerBuild,
          split: LoadedWorkerBuild,
          inlined: LoadedWorkerBuild,
          storedFormat: Schema.Literal(2),
          inlinedFormat: Schema.Literal(1),
          objectCount: Schema.Literal(3),
        }),
      }),
    )(await response.json());
    assert.deepEqual(result.value.split, result.value.loaded);
    assert.deepEqual(result.value.inlined, result.value.loaded);
    return result.value.loaded;
  } finally {
    await runtime.dispose();
  }
}
