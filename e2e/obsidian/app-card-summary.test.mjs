// The hosted Apps page, rendered for real in a virtual DOM. Only its HTTP-backed query atoms, the
// router, the organization route, the failure view and the app-screen badge are replaced, so every
// card reads what a signed-in page would from results this test settles.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const web = join(repo, ".upstream/apps/hosted/web");
const pages = join(web, "src/implementation/pages");
let ui;
let scratch;
let registrator;

// Each replaced module reads the current fixture; atoms are cached per key, like Atom.family.
const fixtureAtoms = `
import { Atom, AsyncResult } from "effect/reactivity";
const cache = new Map();
export const resetFixtureAtoms = () => cache.clear();
export const fixtureAtom = (key) => {
  if (!cache.has(key)) cache.set(key, Atom.make(globalThis.cardFixture.read(key)));
  return cache.get(key);
};
export const pendingAtom = Atom.make(AsyncResult.initial());
`;
const replaced = {
  "contracts/resource-access.ts": `import { Atom } from "effect/reactivity";
import { fixtureAtom } from "fixture-atoms";
export const resourceInventoryAtom = () => fixtureAtom("inventory");
export const createAppListAtoms = () => ({
  filters: Atom.make({ view: "available", group: "all" }),
  query: fixtureAtom("inventory"),
});`,
  "contracts/groups.ts": `import { fixtureAtom } from "fixture-atoms";
export const groupsAtom = () => fixtureAtom("groups");`,
  "pages/app-screen.tsx": `export const AppScreenBadge = () => null;`,
  "@tanstack/react-router": `import { createElement } from "react";
export const Link = ({ children }) => createElement("a", null, children);`,
  "contracts/apps.ts": `import { fixtureAtom } from "fixture-atoms";
export const connectionToolListAtom = (key) => fixtureAtom("tools:" + key.app);`,
  "contracts/mcp-connections.ts": `import { fixtureAtom, pendingAtom } from "fixture-atoms";
export const mcpConnectionsAtom = () => fixtureAtom("connections");
export const mcpAgentsAtom = () => fixtureAtom("agents");
export const revokeMcpAgentAtom = () => pendingAtom;`,
  "contracts/obsidian-vault-sync.ts": `import { fixtureAtom } from "fixture-atoms";
export const vaultSyncAtom = (key) => fixtureAtom("sync:" + key.app);`,
  "components/dashboard-bindings.tsx": `export const HostedFailure = () => null;`,
  "components/organization.tsx": `export const useOrganizationRoute = () => ({
  organization: "org_fixture",
  slug: "fixture",
});`,
};

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "app-card-summary-"));
  const result = await build({
    stdin: {
      contents: [
        'export { AppsPage } from "./apps.tsx";',
        'export { DashboardProvider } from "@executor-js/ui/dashboard/context";',
        'export { obsidianTools } from "../../contracts/obsidian-connection.ts";',
        'export { resetFixtureAtoms } from "fixture-atoms";',
        'export { RegistryProvider } from "@effect/atom-react";',
        'export { Atom, AsyncResult } from "effect/reactivity";',
        'export { Cause } from "effect";',
        'export { act, createElement } from "react";',
        'export { createRoot } from "react-dom/client";',
      ].join("\n"),
      resolveDir: pages,
      loader: "tsx",
    },
    absWorkingDir: web,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["import", "browser"],
    jsx: "automatic",
    define: { "import.meta.env.DEV": "false", "process.env.NODE_ENV": '"development"' },
    loader: { ".svg": "dataurl", ".png": "dataurl", ".css": "empty" },
    logLevel: "silent",
    plugins: [
      {
        name: "fixture-queries",
        setup(builder) {
          builder.onResolve({ filter: /^fixture-atoms$/ }, () => ({
            path: "fixture-atoms",
            namespace: "fixture",
          }));
          builder.onResolve({ filter: /(?:\.tsx?|^@tanstack\/react-router)$/ }, (args) => {
            if (!args.importer.startsWith(pages)) return undefined;
            const target = args.path.startsWith(".") ? join(args.resolveDir, args.path) : args.path;
            const name = Object.keys(replaced).find((suffix) => target.endsWith(suffix));
            return name ? { path: name, namespace: "fixture" } : undefined;
          });
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: args.path === "fixture-atoms" ? fixtureAtoms : replaced[args.path],
            resolveDir: pages,
            loader: "tsx",
          }));
        },
      },
    ],
  });
  const bundle = join(scratch, "apps-page.mjs");
  writeFileSync(bundle, result.outputFiles[0].text);
  const require = createRequire(join(web, "package.json"));
  ({ GlobalRegistrator: registrator } = await import(
    pathToFileURL(require.resolve("@happy-dom/global-registrator")).href
  ));
  registrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // React's development act() queues each task on a new MessageChannel; close it after delivery
  // so no Node port stays open.
  globalThis.MessageChannel = class extends NodeMessageChannel {
    constructor() {
      super();
      const { port1, port2 } = this;
      Object.defineProperty(port1, "onmessage", {
        configurable: true,
        set(handler) {
          port1.addEventListener("message", (event) => {
            port1.close();
            port2.close();
            handler(event);
          });
          port1.start();
        },
      });
    }
  };
  ui = await import(pathToFileURL(bundle).href);
});

after(
  async () => {
    await registrator?.unregister();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  },
  { timeout: 10_000 },
);

const hour = 60 * 60 * 1000;
const app = (id, name, drive) => ({
  id,
  slug: id,
  name,
  copiedFrom: null,
  activeVersion: "ver_fixture",
  createdAt: "2026-11-01T08:00:00.000Z",
  requirements: { accounts: {}, drive },
});
const vault = app("app_fixture_vault", "Obsidian", true);
const notes = app("app_fixture_notes", "Notes", true);
const weather = app("app_fixture_weather", "Weather", false);
// What Connect Obsidian creates: a connection for this one app, run as the app, sync tools only.
const vaultConnection = () => ({
  id: "conn_fixture_mac",
  name: "Obsidian · Mac",
  policy: {
    apps: [
      {
        app: vault.id,
        runsAs: [{ kind: "app" }],
        tools: { kind: "selected", names: [...ui.obsidianTools] },
      },
    ],
  },
  createdAt: "2026-11-11T09:47:00.000Z",
  updatedAt: "2026-11-11T09:47:00.000Z",
});
const device = (lastActiveAt) => ({
  id: "grant_fixture_mac",
  name: "Signalbox Obsidian Sync",
  connectedAt: "2026-11-11T09:47:00.000Z",
  lastActiveAt,
  access: { kind: "connection", connection: "conn_fixture_mac", name: "Obsidian · Mac" },
});
const success = (value) => ui.AsyncResult.success(value);
const tools = (names) => success(names.map((name) => ({ name })));

/**
 * Mount the Apps page as the hosted page wires it and return each card's footer text. `results`
 * maps a query key to its settled result; every other query stays pending.
 */
async function cards(results) {
  ui.resetFixtureAtoms();
  const all = {
    inventory: success({ apps: [vault, notes, weather], links: [], accounts: [] }),
    groups: success({ groups: [] }),
    ...results,
  };
  globalThis.cardFixture = { read: (key) => all[key] ?? ui.AsyncResult.initial() };
  const AppLink = ({ app: id, children, ...props }) =>
    ui.createElement("a", { ...props, href: `#${id}` }, children);
  const container = document.createElement("div");
  document.body.append(container);
  const root = ui.createRoot(container);
  await ui.act(async () => {
    root.render(
      ui.createElement(
        ui.RegistryProvider,
        null,
        ui.createElement(
          ui.DashboardProvider,
          {
            AppLink,
            AccountLink: AppLink,
            catalogIcons: ui.Atom.make({ settled: true, byPackage: new Map(), byName: new Map() }),
          },
          ui.createElement(ui.AppsPage),
        ),
      ),
    );
  });
  const text = (name) =>
    container
      .querySelector(`[aria-label^="Open ${name}"]`)
      ?.querySelector(".app-card-footer")
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
  const result = {
    vault: text("Obsidian"),
    notes: text("Notes"),
    weather: text("Weather"),
    loading: container.querySelectorAll('[aria-label="Loading status"]').length,
  };
  await ui.act(async () => root.unmount());
  container.remove();
  return result;
}

const settled = (agents, extra = {}) => ({
  "tools:app_fixture_vault": tools(ui.obsidianTools),
  "tools:app_fixture_notes": tools(["read", "write"]),
  connections: success([vaultConnection()]),
  agents: success(agents),
  ...extra,
});

test("a vault with a connected device says so instead of 'No account required'", async () => {
  const result = await cards(settled([device(new Date(Date.now() - 26 * hour).toISOString())]));
  assert.ok(result.vault, "the vault's card renders");
  assert.doesNotMatch(result.vault, /No account required/);
  assert.match(result.vault, /^1 device · active /);
  // Apps the host knows nothing about keep the shared copy: a drive app without the sync
  // protocol once its tools load, and an app without a drive without any read.
  assert.equal(result.notes, "No account required");
  assert.equal(result.weather, "No account required");
});

test("a vault no device syncs invites a connection", async () => {
  const result = await cards(settled([]));
  assert.equal(result.vault, "No devices yet · Connect one");
});

test("a device's own sync record outranks its grant activity, as on the Accounts tab", async () => {
  const synced = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const result = await cards(
    settled([device(new Date(Date.now() - 26 * hour).toISOString())], {
      "tools:app_fixture_vault": tools([...ui.obsidianTools, "devices"]),
      "sync:app_fixture_vault": success({
        head: "h2",
        devices: [{ agent: "grant_fixture_mac", lastSyncAt: synced, lastHead: "h2" }],
      }),
    }),
  );
  assert.match(result.vault ?? "", /^1 device · synced /);
});

test("while a drive app's tools load, its card claims neither devices nor 'No account required'", async () => {
  const result = await cards({});
  assert.equal(result.loading, 2);
  for (const line of [result.vault, result.notes]) {
    assert.doesNotMatch(line ?? "", /No account required|device/i);
  }
  assert.equal(result.weather, "No account required");
});

test("a failed device read says the status couldn't load rather than 'No account required'", async () => {
  const result = await cards({
    ...settled([]),
    agents: ui.AsyncResult.failure(ui.Cause.fail(new Error("unavailable"))),
  });
  assert.equal(result.vault, "Status couldn't be loaded");
  assert.equal(result.notes, "No account required");
});

test("a drive app whose tools can't be read never claims devices or 'No account required'", async () => {
  const failed = ui.AsyncResult.failure(ui.Cause.fail(new Error("unavailable")));
  const result = await cards({
    ...settled([]),
    "tools:app_fixture_vault": failed,
    "tools:app_fixture_notes": failed,
  });
  assert.equal(result.vault, "Status couldn't be loaded");
  assert.equal(result.notes, "Status couldn't be loaded");
  assert.equal(result.weather, "No account required");
});
