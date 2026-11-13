import assert from "node:assert/strict";
import { Miniflare } from "../pool-test-runtime/index.ts";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, ".upstream/package.json"));
const sdk = createRequire(join(root, ".upstream/packages/sdk/package.json"));
const { build } = sdk("esbuild");
const sqlite =
  process.env.SQLITE_WASM_PACKAGE ??
  dirname(require.resolve("@sqlite.org/sqlite-wasm/package.json"));
const output = resolve(process.argv[2]);
assert.ok(
  process.argv[2] && !output.startsWith(root),
  "Supply an output directory outside the checkout",
);
const directory = mkdtempSync(join(tmpdir(), "sqlite-compiler-"));
let runtime;
try {
  const wasm = [];
  await build({
    entryPoints: [join(root, "scripts/pool-tests/sqlite-compiler-worker.mjs")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    outfile: join(directory, "entry.mjs"),
    external: ["cloudflare:*", "node:*"],
    logLevel: "error",
    plugins: [
      {
        name: "workerd-wasm-modules",
        setup(builder) {
          builder.onResolve({ filter: /\.wasm$/ }, (args) => {
            const path = args.path.startsWith(".")
              ? join(args.resolveDir, args.path)
              : createRequire(join(args.resolveDir, "package.json")).resolve(args.path);
            const name = `module-${wasm.length}.wasm`;
            wasm.push({
              type: "CompiledWasm",
              path: join(directory, name),
              contents: readFileSync(path),
            });
            return { path: `./${name}`, external: true };
          });
        },
      },
    ],
  });
  runtime = new Miniflare({
    modulesRoot: directory,
    modules: [{ type: "ESModule", path: join(directory, "entry.mjs") }, ...wasm],
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
  });
  const files = readdirSync(join(root, "apps/pool/ui"))
    .filter((name) => name.startsWith("sqlite-") && name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => ({
      path: `ui/${name}`,
      content: readFileSync(join(root, "apps/pool/ui", name), "utf8"),
    }));
  files.push({
    path: "package.json",
    content: readFileSync(join(root, "apps/pool/package.json"), "utf8"),
  });
  // Compile the actual worker entry independently of the unchanged React entry.
  files.push({
    path: "ui/index.html",
    content: readFileSync(join(root, "apps/pool/ui/index.html"), "utf8").replace(
      /<script type="module" src="\.\/main.tsx"><\/script>/,
      "",
    ),
  });
  const dependency = {};
  for (const name of readdirSync(sqlite, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(sqlite.length + 1)))
    dependency[`node_modules/@sqlite.org/sqlite-wasm/${name}`] = name.endsWith(".wasm")
      ? [...readFileSync(join(sqlite, name))]
      : readFileSync(join(sqlite, name), "utf8");
  const response = await runtime.dispatchFetch("http://compiler.test/", {
    method: "POST",
    body: JSON.stringify({ files, dependency }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const { assets } = await response.json();
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "package.json"), '{"type":"module"}');
  for (const asset of assets) writeFileSync(join(output, asset.path), Buffer.from(asset.body));
  const binary = assets.find((asset) => asset.path.endsWith(".wasm"));
  assert.ok(binary);
  assert.equal(binary.contentType, "application/wasm");
  assert.deepEqual(Buffer.from(binary.body), readFileSync(join(sqlite, "dist/sqlite3.wasm")));
  assert.ok(WebAssembly.validate(new Uint8Array(binary.body)));
  const document = await runtime.dispatchFetch("http://compiler.test/");
  assert.equal(document.status, 200);
  const html = await document.text();
  const versionedEntry = html.match(/data-usage-sqlite-worker[^>]*src="([^"]+)"/)[1];
  assert.match(versionedEntry, /^\/_executor\/assets\/[a-f0-9]{64}\/sqlite-worker-[A-Z0-9]+\.js$/);
  const entry = versionedEntry.split("/").at(-1);
  assert.ok(assets.some((asset) => asset.path === entry));
  for (const asset of assets.filter((asset) => asset.path !== "index.html")) {
    const served = await runtime.dispatchFetch(
      new URL(asset.path, `http://compiler.test${versionedEntry}`),
    );
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), asset.contentType);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from(asset.body));
  }
  const report = {
    entry,
    versionedEntry,
    wasm: binary.path,
    wasmBytes: binary.body.length,
    assets: assets.map(({ path, contentType, body }) => ({
      path,
      contentType,
      bytes: body.length,
    })),
  };
  writeFileSync(join(output, "manifest.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await runtime?.dispose();
  rmSync(directory, { recursive: true });
}
