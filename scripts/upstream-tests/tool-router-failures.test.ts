import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { build } = require("esbuild") as typeof import("../../.upstream/node_modules/esbuild");
const { chromium } =
  require("playwright") as typeof import("../../.upstream/node_modules/playwright");

test("a failed tool router stays named until a refresh returns a complete catalog", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "basalt-tool-router-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const bundle = join(scratch, "fixture.js");
    await build({
      stdin: {
        contents: `
import { createRoot } from "react-dom/client";
import { RegistryProvider } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { Effect } from "effect";
import { ToolBrowser } from "./src/implementation/dashboard/tools.tsx";
window.catalog = { tools: [], routers: [{ path: "calendar", title: "Calendar", error: { _tag: "HostEvaluationFailed", message: "Fixture source refused" } }] };
const query = Atom.make(Effect.sync(() => { return window.catalog; }));
createRoot(document.getElementById("root")).render(
  <RegistryProvider><ToolBrowser query={query} detail={() => query} selected={undefined} onSelect={() => {}} Failure={() => <p>Query failed</p>} /></RegistryProvider>
);`,
        loader: "tsx",
        resolveDir: join(root, ".upstream/packages/ui"),
      },
      outfile: bundle,
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ path: bundle, type: "module" });
    await page
      .getByText(/No tools|Couldn't load Calendar/)
      .first()
      .waitFor();
    assert.equal(await page.getByText("Couldn't load Calendar tools.", { exact: true }).count(), 1);
    assert.equal(await page.getByText("No tools", { exact: true }).count(), 0);
    await page.evaluate(() => {
      Object.assign(window, { catalog: { tools: [], routers: [] } });
    });
    await page.getByRole("button", { name: "Refresh tools", exact: true }).click();
    await page.getByText("No tools", { exact: true }).waitFor();
    assert.equal(await page.getByText("Couldn't load Calendar tools.", { exact: true }).count(), 0);
  } finally {
    await browser.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
