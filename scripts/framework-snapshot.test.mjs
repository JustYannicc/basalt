import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { stableFrameworkPaths } from "../.upstream/packages/apps/scripts/stable-framework-paths.mjs";

const require = createRequire(new URL("../.upstream/packages/apps/package.json", import.meta.url));
const { build } = require("esbuild");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function put(file, contents) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function fixture(directory, generation) {
  const root = join(directory, "checkout");
  const store = join(directory, "prepared", "key", "generations", generation, "node_modules/.bun");
  await put(join(root, "package.json"), '{"type":"module"}');
  await put(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", strict: true, verbatimModuleSyntax: true },
    }),
  );
  const esm = join(store, "fixture@1.0.0/node_modules/fixture");
  const cjs = join(store, "legacy@1.0.0/node_modules/legacy");
  await put(join(cjs, "package.json"), '{"main":"index.js","type":"commonjs"}');
  await put(join(cjs, "index.js"), 'exports.__esModule=true;exports.default="legacy";');
  await put(join(esm, "package.json"), '{"main":"index.js","type":"module"}');
  await put(
    join(esm, "index.js"),
    'import value from "legacy"; export const legacy=value.default; export const strictThis=(function(){return this})();',
  );
  await symlink("../../legacy@1.0.0/node_modules/legacy", join(esm, "../legacy"));
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(store, join(root, "node_modules/.bun"));
  await symlink(".bun/fixture@1.0.0/node_modules/fixture", join(root, "node_modules/fixture"));
  await put(
    join(root, "packages/apps/src/side-effect.ts"),
    "globalThis.frameworkSideEffect=7; export const unused=0;",
  );
  const source = `
import { unused } from "./side-effect.ts";
import { legacy, strictThis } from "fixture";
class Fields { field=3; constructor(){ this.field=4; } }
export const observed=[legacy,strictThis===undefined,globalThis.frameworkSideEffect,new Fields().field];
`;
  await put(join(root, "packages/apps/src/index.ts"), source);
  await put(
    join(root, "packages/apps/src/host.ts"),
    'import { legacy } from "fixture"; export const host=legacy;',
  );
  await put(join(root, "packages/apps/src/browser.ts"), 'export { observed } from "./index.ts";');
  return root;
}

async function snapshot(root, cwd, stable, browser = false) {
  const paths = await stableFrameworkPaths(root);
  const output = join(root, stable ? ".stable" : ".native", browser ? "browser" : "server");
  const result = await build({
    absWorkingDir: stable ? root : cwd,
    entryPoints: {
      index: join(root, "packages/apps/src/index.ts"),
      host: join(root, "packages/apps/src/host.ts"),
      ...(browser ? { browser: join(root, "packages/apps/src/browser.ts") } : {}),
    },
    outdir: output,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    ...(stable ? { plugins: [paths.plugin] } : {}),
  });
  const modules = Object.fromEntries(
    result.outputFiles.map((file) => [relative(output, file.path), file.text]),
  );
  for (const file of result.outputFiles) await put(file.path, file.text);
  delete globalThis.frameworkSideEffect;
  const loaded = await import(pathToFileURL(join(output, "index.js")).href);
  return {
    hash: digest(
      Object.keys(modules)
        .sort()
        .map((name) => [name, modules[name]]),
    ),
    observed: loaded.observed,
  };
}

test("framework snapshots retain loader behavior and exact bytes across checkout, cwd and store roots", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "framework-snapshot-"));
  try {
    const hashes = [];
    const nativeHashes = [];
    for (const [directory, generation] of [
      ["one", "00000000-0000-4000-8000-000000000001"],
      ["a/deeper/second", "00000000-0000-4000-8000-000000000002"],
      ["third/root/with/another/depth", "00000000-0000-4000-8000-000000000003"],
    ]) {
      const root = await fixture(join(temporary, directory), generation);
      const cwd = dirname(root);
      const native = await snapshot(root, cwd, false);
      const server = await snapshot(root, cwd, true);
      const browser = await snapshot(root, cwd, true, true);
      assert.deepEqual(native.observed, ["legacy", true, 7, 4]);
      assert.deepEqual(server.observed, native.observed);
      assert.deepEqual(browser.observed, native.observed);
      hashes.push([server.hash, browser.hash]);
      nativeHashes.push(native.hash);
    }
    assert.notEqual(nativeHashes[1], nativeHashes[0]);
    assert.deepEqual(hashes[1], hashes[0]);
    assert.deepEqual(hashes[2], hashes[0]);
    const root = join(temporary, "one/checkout");
    await writeFile(
      join(root, "packages/apps/src/side-effect.ts"),
      "globalThis.frameworkSideEffect=8; export const unused=0;",
    );
    const changed = await snapshot(root, root, true);
    assert.notEqual(changed.hash, hashes[0][0]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
