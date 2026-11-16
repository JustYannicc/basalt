import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { stableFrameworkPaths } from "../../.upstream/packages/apps/scripts/stable-framework-paths.mjs";

const { build } = createRequire(
  new URL("../../.upstream/packages/apps/package.json", import.meta.url),
)("esbuild");

for (const [name, manifest, files, expected] of [
  [
    "pure ESM siblings",
    { type: "module", sideEffects: false },
    {
      "index.js": 'export { value } from "./value.js";',
      "value.js": 'export const value = "original";',
    },
    "original",
  ],
  [
    "pure CommonJS siblings",
    { type: "commonjs", sideEffects: false },
    {
      "index.js": 'exports.value = require("./value.js").value;',
      "value.js": 'exports.value = "commonjs";',
    },
    "commonjs",
  ],
  [
    "browser remaps",
    { type: "module", sideEffects: false, browser: { "./value.js": "./browser.js" } },
    {
      "index.js": 'export { value } from "./value.js";',
      "value.js": 'export const value = "wrong";',
      "browser.js": 'export const value = "browser";',
    },
    "browser",
  ],
  [
    "declared side effects",
    { type: "module", sideEffects: ["./effect.js"] },
    {
      "index.js":
        'import "./effect.js"; export const value = globalThis.__frameworkResolutionFixture;',
      "effect.js": 'globalThis.__frameworkResolutionFixture = "effect";',
    },
    "effect",
  ],
])
  test(`stable framework paths preserve ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "framework-resolution-"));
    try {
      const dependency = join(directory, "node_modules/.bun/fixture@1.0.0/node_modules/fixture");
      await mkdir(dependency, { recursive: true });
      await writeFile(
        join(dependency, "package.json"),
        JSON.stringify({ name: "fixture", main: "index.js", ...manifest }),
      );
      for (const [file, contents] of Object.entries(files))
        await writeFile(join(dependency, file), contents);
      await symlink(dependency, join(directory, "node_modules/fixture"));
      await writeFile(join(directory, "entry.js"), 'export { value } from "fixture";');
      const paths = await stableFrameworkPaths(directory);
      const result = await build({
        absWorkingDir: directory,
        entryPoints: ["entry.js"],
        outfile: join(directory, "out.mjs"),
        platform: "browser",
        format: "esm",
        bundle: true,
        write: false,
        plugins: [paths.plugin],
      });
      const bundle = result.outputFiles[0].text;
      const loaded = await import(
        `data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`
      );
      assert.equal(loaded.value, expected);
      assert.ok(
        !bundle.includes(directory),
        "Dependency identities must not retain temporary roots",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
