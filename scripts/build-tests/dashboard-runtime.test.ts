import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertDashboardRuntimeBundle,
  checkDashboardRuntimeBundle,
  chunkSources,
} from "../dashboard-runtime-bundle.ts";

const client = ["main-abc12345.js", "highlight-engine-DkJn57Z2.js"];
const chunk = "apps/hosted/cloud/web/dist/server/assets/code-AbC12345.js";

test("the production dashboard upload leaves the code highlighter to the browser", () => {
  checkDashboardRuntimeBundle();
});

test("the dashboard boundary rejects the highlighter at any size", () => {
  for (const source of [
    "apps/hosted/cloud/web/dist/server/assets/highlight-engine-DkJn57Z2.js",
    "node_modules/.bun/@shikijs+langs@3.23.0/node_modules/@shikijs/langs/dist/typescript.mjs",
    "node_modules/shiki/dist/core.mjs",
    "node_modules/oniguruma-to-es/dist/esm/index.js",
    "packages/ui/src/implementation/highlight-engine.ts",
  ])
    assert.throws(
      () =>
        assertDashboardRuntimeBundle(
          { worker: "dashboard", sources: { [source]: 1 } },
          client,
          () => [],
        ),
      /must not upload the code highlighter/,
    );
});

test("the dashboard boundary reads inside the site's prebuilt chunks", () => {
  const upload = { worker: "dashboard", sources: { [chunk]: 1 } };
  assert.throws(
    () =>
      assertDashboardRuntimeBundle(upload, client, () => [
        "../../../../../../.cache/x/node_modules/.bun/@shikijs+core@3.23.0/node_modules/@shikijs/core/dist/index.mjs",
      ]),
    /must not upload the code highlighter.*code-AbC12345\.js \(.*@shikijs\/core/,
  );
  // The stub and the contracts that load it are not the engine.
  assert.doesNotThrow(() =>
    assertDashboardRuntimeBundle(upload, client, () => [
      "../../server-highlight-engine.ts",
      "../../../../../../packages/ui/src/contracts/highlight.ts",
    ]),
  );
});

test("the dashboard boundary requires the browser build to keep the highlighter", () => {
  const upload = { worker: "dashboard", sources: { [chunk]: 1 } };
  assert.throws(
    () => assertDashboardRuntimeBundle(upload, ["main-abc12345.js"], () => []),
    /browser build must keep the code highlighter/,
  );
});

test("the dashboard boundary refuses a missing attribution or another Worker", () => {
  assert.throws(() => assertDashboardRuntimeBundle({ worker: "dashboard", sources: {} }, client));
  assert.throws(() =>
    assertDashboardRuntimeBundle({ worker: "api", sources: { "entry.ts": 1 } }, client),
  );
});

test("a chunk the record names must exist and carry a source map", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-dashboard-chunks-"));
  try {
    const assets = join(root, "apps/hosted/cloud/web/dist/server/assets");
    mkdirSync(assets, { recursive: true });
    const read = chunkSources(pathToFileURL(`${root}/`));
    const manifest = "apps/hosted/cloud/web/dist/server/assets/_tanstack-start-manifest_v-B8Hh.js";
    // A stale record, such as one from before the site was rebuilt, would otherwise pass unread.
    assert.throws(() => read(chunk), /no longer has; rebuild the Workers/);
    writeFileSync(join(root, chunk), "export {};");
    assert.throws(() => read(chunk), /has no source map/);
    writeFileSync(join(root, `${chunk}.map`), JSON.stringify({ sources: ["../../a.ts"] }));
    assert.deepEqual(read(chunk), ["../../a.ts"]);
    writeFileSync(join(root, manifest), "export {};");
    assert.deepEqual(read(manifest), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
