import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { createApp, InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { Effect } from "effect";
import { browserBuild } from "./packages/sdk/src/implementation/worker-browser-build.ts";
export default {
  async fetch(request) {
    const files = await request.json();
    const filesystem = new InMemoryFileSystem(files);
    const browser = await Effect.runPromise(browserBuild(
      Object.entries(files).map(([path, content]) => ({ path, content })),
      filesystem, { entries: ["ui.ts"] }, {},
    ));
    try {
      const compiled = await createApp({
        files: filesystem, server: "index.ts", client: "ui.ts", installDependencies: false,
        __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [browser.plugin],
      });
      return Response.json({ compiled: JSON.stringify(compiled), errors: [] });
    } catch (error) {
      return Response.json({ compiled: null, errors: error.errors?.map(item => item.text) ?? [String(error)] });
    }
  },
};`;

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      compiled: Schema.NullOr(Schema.String),
      errors: Schema.Array(Schema.String),
    }),
  ),
);
const prefix = "Browser compilation returned invalid outputs or unresolved imports.";
const fixture = (imports: Record<string, unknown>, source: string) => ({
  "package.json": JSON.stringify({ dependencies: { "subpath-fixture": "1.0.0" } }),
  "index.ts": "export default { fetch() { return new Response('ok') } }",
  "ui.ts": "import { value } from 'subpath-fixture'; globalThis.fixtureValue = value;",
  "node_modules/subpath-fixture/package.json": JSON.stringify({
    name: "subpath-fixture",
    version: "1.0.0",
    exports: "./src/index.js",
    imports,
  }),
  "node_modules/subpath-fixture/src/index.js": source,
  "node_modules/subpath-fixture/browser-path.js": "export default 'browser-path';",
  "node_modules/subpath-fixture/browser-proc.js": "export default 'browser-proc';",
  "node_modules/subpath-fixture/browser-url.js": "export default 'browser-url';",
  "node_modules/subpath-fixture/node.js": "export default 'wrong-node-branch';",
});

test(
  "the real browser compiler resolves package imports and names unresolved specifiers",
  { timeout: 15_000 },
  async (t) => {
    const bundled = await build({
      stdin: {
        contents: worker,
        resolveDir: upstream,
        sourcefile: "package-imports-worker.ts",
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
      target: "es2023",
      logLevel: "silent",
      loader: { ".wasm": "binary" },
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
    const runtime = new Miniflare({
      modules: [
        { type: "ESModule", path: "package-imports.mjs", contents: bundled.outputFiles[0]!.text },
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
    });
    const compile = async (files: Record<string, string>) => {
      const response = await runtime.dispatchFetch("http://unlisted.invalid", {
        method: "POST",
        body: JSON.stringify(files),
      });
      assert.equal(response.status, 200);
      return decode(await response.text());
    };
    try {
      await t.test("vfile-style node/default conditions select the browser branch", async () => {
        const result = await compile(
          fixture(
            {
              "#minpath": { node: "./node.js", default: "./browser-path.js" },
              "#minproc": { node: "./node.js", default: "./browser-proc.js" },
              "#minurl": { node: "./node.js", default: "./browser-url.js" },
            },
            "import path from '#minpath'; import proc from '#minproc'; import url from '#minurl'; export const value = [path, proc, url].join(':');",
          ),
        );
        assert.deepEqual(result.errors, []);
        assert.ok(result.compiled);
        for (const name of ["browser-path", "browser-proc", "browser-url"])
          assert.ok(result.compiled.includes(name));
        assert.ok(!result.compiled.includes("wrong-node-branch"));
        for (const name of ["#minpath", "#minproc", "#minurl"])
          assert.ok(!result.compiled.includes(name));
      });
      await t.test("imports support patterns and external package aliases", async () => {
        const files = fixture(
          { "#part/*": "./browser-*.js", "#other": "other-fixture" },
          "import path from '#part/path'; import other from '#other'; export const value = path + other;",
        );
        const result = await compile({
          ...files,
          "node_modules/other-fixture/package.json": JSON.stringify({
            name: "other-fixture",
            exports: "./index.js",
          }),
          "node_modules/other-fixture/index.js": "export default 'other-value';",
        });
        assert.deepEqual(result.errors, []);
        assert.ok(result.compiled?.includes("browser-path"));
        assert.ok(result.compiled?.includes("other-value"));
      });
      await t.test("the app's own package scope resolves root imports", async () => {
        const files = fixture({}, "export const value = 'unused';");
        const result = await compile({
          ...files,
          "package.json": JSON.stringify({ imports: { "#root": "./root.js" } }),
          "root.js": "export default 'root-value';",
          "ui.ts": "import value from '#root'; globalThis.fixtureValue = value;",
        });
        assert.deepEqual(result.errors, []);
        assert.ok(result.compiled?.includes("root-value"));
      });
      await t.test("all unresolved imports are reported once in stable order", async () => {
        const result = await compile(
          fixture(
            {},
            "import a from '#missing-z'; import b from '#missing-a'; import c from '#missing-z'; export const value = [a,b,c];",
          ),
        );
        assert.equal(result.compiled, null);
        assert.ok(
          result.errors.includes(prefix + ' Unresolved imports: ["#missing-a","#missing-z"]'),
          JSON.stringify(result),
        );
      });
      for (const [name, imports] of Object.entries({
        blocked: { "#bad": null },
        escape: { "#bad": "./../browser-path.js" },
        cycle: { "#bad": "#again", "#again": "#bad" },
      })) {
        await t.test(`invalid ${name} mappings remain unresolved`, async () => {
          const result = await compile(
            fixture(imports, "import bad from '#bad'; export const value = bad;"),
          );
          assert.equal(result.compiled, null);
          assert.ok(
            result.errors.includes(prefix + ' Unresolved imports: ["#bad"]'),
            JSON.stringify(result),
          );
        });
      }
      await t.test("a dependency cannot borrow the surrounding app's imports", async () => {
        const files = fixture({}, "import path from '#minpath'; export const value = path;");
        const result = await compile({
          ...files,
          "package.json": JSON.stringify({ imports: { "#minpath": "./root.js" } }),
          "root.js": "export default 'must-not-leak';",
        });
        assert.equal(result.compiled, null);
        assert.ok(
          result.errors.includes(prefix + ' Unresolved imports: ["#minpath"]'),
          JSON.stringify(result),
        );
      });
    } finally {
      await runtime.dispose();
    }
  },
);
