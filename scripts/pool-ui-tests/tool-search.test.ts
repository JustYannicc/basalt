import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { launchBrowser } from "../../.upstream/e2e/support/browser-launch.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { build } =
  require("esbuild") as typeof import("../../.upstream/node_modules/esbuild/lib/main.js");

const tools = [
  { name: "archive", description: "Archive events from the list of old records" },
  { name: "events_listing", description: "Browse scheduled items" },
  { name: "events_list", description: "Read scheduled items" },
  { name: "calendars_list", description: "Read calendars" },
  { name: "calendar_events", description: "Read calendar entries" },
  { name: "messages_list", description: "Read messages" },
  { name: "lookup", title: "Events list", description: "Read scheduled items" },
  { name: "unrelated", description: "Change account settings" },
].map((tool) => ({ ...tool, inputSchema: { type: "object", properties: {} } }));

for (const surface of ["browser", "connection", "grant"])
  test(`${surface} tool search matches every word and ranks names and titles first`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "basalt-tool-search-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(launchBrowser({ headless: true, slowMo: 0 }), (browser) =>
            Effect.promise(async () => {
              const bundle = join(scratch, "fixture.js");
              await build({
                stdin: {
                  contents: `
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { RegistryProvider } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { Effect } from "effect";
import { ToolBrowser } from "./src/implementation/dashboard/tools.tsx";
import { ConnectionToolPicker } from "./src/implementation/dashboard/connection-tool-picker.tsx";
import { GrantPicker } from "./src/implementation/dashboard/grant-picker.tsx";
const tools = ${JSON.stringify(tools)};
const catalog = Atom.make(Effect.succeed({ tools, routers: [] }));
const list = Atom.make(Effect.succeed(tools));
const detail = Atom.make(Effect.succeed(undefined));
function Fixture() {
  const [selected, select] = useState();
  const [names, setNames] = useState([]);
  const [policy, setPolicy] = useState({ kind: "tools", approval: "browser", apps: [{ app: "fixture", tools: { kind: "selected", names: [] } }] });
  return ${surface === "browser" ? "<ToolBrowser query={catalog} detail={() => detail} selected={selected} onSelect={select} Failure={() => <p>Failed</p>} />" : surface === "connection" ? "<ConnectionToolPicker query={list} names={names} onChange={setNames} Failure={() => <p>Failed</p>} />" : '<GrantPicker apps={[{ id: "fixture", name: "Fixture" }]} tools={() => list} policy={policy} onChange={setPolicy} />'};
}
createRoot(document.getElementById("root")).render(<RegistryProvider><Fixture /></RegistryProvider>);`,
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
              const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
              await page.setContent('<div id="root"></div>');
              await page.addScriptTag({ path: bundle, type: "module" });
              const search = page.getByRole("textbox").first();
              await search.waitFor();
              const selector =
                surface === "browser"
                  ? 'nav[aria-label="App tools"] button[title]'
                  : surface === "connection"
                    ? "label[for]"
                    : ".grant-tool-list label";
              const names = () =>
                page
                  .locator(selector)
                  .evaluateAll((rows) =>
                    rows.map(
                      (row) =>
                        row.getAttribute("aria-label") ??
                        row.querySelector(".font-mono, code")?.textContent?.trim(),
                    ),
                  );
              const waitForNames = (expected: readonly string[], ordered = false) =>
                page
                  .waitForFunction(
                    ({ selector, expected, ordered }) => {
                      const actual = Array.from(
                        document.querySelectorAll(selector),
                        (row) =>
                          row.getAttribute("aria-label") ??
                          row.querySelector(".font-mono, code")?.textContent?.trim(),
                      );
                      return (
                        JSON.stringify(ordered ? actual : actual.sort()) ===
                        JSON.stringify(ordered ? expected : [...expected].sort())
                      );
                    },
                    { selector, expected: [...expected], ordered },
                    { timeout: 2000 },
                  )
                  .catch((error: Error) => {
                    if (error.name !== "TimeoutError") throw error;
                  });
              await waitForNames(tools.map((tool) => tool.name));
              assert.deepEqual((await names()).sort(), tools.map((tool) => tool.name).sort());
              for (const [query, expected] of [
                ["events list", ["archive", "events_listing", "events_list", "lookup"]],
                ["list calendars", ["calendars_list"]],
                ["calendar events", ["calendar_events"]],
                ["messages list", ["messages_list"]],
                ["LiSt   EvEnTs", ["archive", "events_listing", "events_list", "lookup"]],
              ] as const) {
                await search.fill(query);
                await waitForNames(expected);
                assert.deepEqual((await names()).sort(), [...expected].sort(), query);
              }
              await search.fill("events list");
              const ranked = ["events_list", "lookup", "events_listing", "archive"];
              await waitForNames(ranked, true);
              assert.deepEqual(
                await names(),
                ranked,
                "exact names and titles, then prefixes, then descriptions; ties keep catalog order",
              );
              for (const [query, expected] of [
                [
                  "events",
                  ["archive", "events_listing", "events_list", "calendar_events", "lookup"],
                ],
                [
                  "list",
                  [
                    "archive",
                    "events_listing",
                    "events_list",
                    "calendars_list",
                    "messages_list",
                    "lookup",
                  ],
                ],
                ["", tools.map((tool) => tool.name)],
                ["  \t ", tools.map((tool) => tool.name)],
              ] as const) {
                await search.fill(query);
                await waitForNames(expected);
                assert.deepEqual((await names()).sort(), [...expected].sort(), query);
              }
              await search.fill("events nonexistent");
              await waitForNames([]);
              assert.deepEqual(await names(), []);
            }),
          ),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
