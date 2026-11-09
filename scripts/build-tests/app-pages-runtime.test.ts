import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAppPagesRuntimeBundle,
  checkAppPagesRuntimeBundle,
} from "../app-pages-runtime-bundle.ts";

test("the production AppPages upload contains no HTML parser or local OS services", () => {
  checkAppPagesRuntimeBundle();
});

test("the AppPages boundary rejects parser and local OS modules at any size", () => {
  for (const source of [
    "node_modules/parse5/dist/parser/index.js",
    "node_modules/.bun/parse5@8.0.0/node_modules/parse5/dist/tokenizer/index.js",
    "node_modules/@effect/platform-node-shared/dist/NodeFileSystem.js",
    "node_modules/@effect/platform-node/dist/NodeChildProcessSpawner.js",
    "node_modules/@effect/platform-node-shared/dist/NodeTerminal.js",
    "node_modules/@effect/platform-node-shared/dist/NodeStdio.js",
  ])
    assert.throws(
      () => assertAppPagesRuntimeBundle({ worker: "app-pages", sources: { [source]: 1 } }),
      /must not upload an HTML parser or local OS services/,
    );
});

test("the AppPages boundary refuses a missing attribution or another Worker", () => {
  assert.throws(() => assertAppPagesRuntimeBundle({ worker: "app-pages", sources: {} }));
  assert.throws(() => assertAppPagesRuntimeBundle({ worker: "api", sources: { "entry.ts": 1 } }));
});
