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
const grammar = (name: string) =>
  `../../../../node_modules/.bun/@shikijs+langs@3.23.0/node_modules/@shikijs/langs/dist/${name}.mjs`;
/** What the server engine's chunk holds: its three grammars and the shared Shiki core. */
const serverEngine = [
  ...["typescript", "json", "shellscript"].map(grammar),
  "../../../../node_modules/.bun/@shikijs+core@3.23.0/node_modules/@shikijs/core/dist/index.mjs",
  "../../../../packages/ui/src/implementation/server-highlight-engine.ts",
];
const upload = { worker: "dashboard", sources: { [chunk]: 1 } };

test("the production dashboard upload carries only the server grammars", () => {
  checkDashboardRuntimeBundle();
});

test("the dashboard upload keeps the three server grammars and the shared core", () => {
  assert.doesNotThrow(() => assertDashboardRuntimeBundle(upload, client, () => serverEngine));
  for (const name of ["typescript", "json", "shellscript"])
    assert.throws(
      () =>
        assertDashboardRuntimeBundle(upload, client, () =>
          serverEngine.filter((path) => path !== grammar(name)),
        ),
      new RegExp(`server render must keep the ${name} grammars`),
    );
});

test("the dashboard upload refuses every other grammar and the full engine", () => {
  for (const extra of [
    ...["javascript", "css", "html", "markdown", "python"].map(grammar),
    "../../../../packages/ui/src/implementation/highlight-engine.ts",
  ])
    assert.throws(
      () => assertDashboardRuntimeBundle(upload, client, () => [...serverEngine, extra]),
      /must upload only the typescript, json, shellscript grammars.*code-AbC12345\.js \(/,
    );
  // A source of its own counts too, not only one inside a site chunk.
  assert.throws(
    () =>
      assertDashboardRuntimeBundle(
        {
          worker: "dashboard",
          sources: {
            [chunk]: 1,
            "apps/hosted/cloud/web/dist/server/assets/highlight-engine-x1.js": 1,
          },
        },
        client,
        () => serverEngine,
      ),
    /must upload only/,
  );
});

test("the dashboard boundary requires the browser build to keep the full engine", () => {
  assert.throws(
    () => assertDashboardRuntimeBundle(upload, ["main-abc12345.js"], () => serverEngine),
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
