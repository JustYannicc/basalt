// Hosted dashboard pages, rendered for real in a virtual DOM. Only their HTTP-backed query atoms,
// the router, the organization route, the failure view and the app-screen badge are replaced, by
// atoms a test settles, so every component reads what a signed-in page would.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { MessageChannel as NodeMessageChannel } from "node:worker_threads";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const web = join(repo, ".upstream/apps/hosted/web");
const pages = join(web, "src/implementation/pages");

// Each replaced module reads the current fixture; atoms are cached per key, like Atom.family.
const fixtureAtoms = `
import { Atom, AsyncResult } from "effect/reactivity";
const cache = new Map();
export const resetFixtureAtoms = () => cache.clear();
export const fixtureAtom = (key) => {
  if (!cache.has(key)) cache.set(key, Atom.make(globalThis.hostedFixture.read(key)));
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
const path = (to, params = {}) => to.replace(/\\$(\\w+)/g, (_, key) => params[key] ?? "");
export const Link = ({ children, to, params, search, className }) =>
  createElement(
    "a",
    { className, href: to && path(to, params) + (search ? "?" + new URLSearchParams(search) : "") },
    children,
  );
export const useNavigate = () => () => undefined;`,
  "contracts/apps.ts": `import { fixtureAtom } from "fixture-atoms";
export const connectionToolListAtom = (key) => fixtureAtom("tools:" + key.app);`,
  "contracts/mcp-connections.ts": `import { fixtureAtom, pendingAtom } from "fixture-atoms";
export const mcpConnectionsAtom = () => fixtureAtom("connections");
export const mcpAgentsAtom = () => fixtureAtom("agents");
export const revokeMcpAgentAtom = () => pendingAtom;`,
  "contracts/obsidian-vault-sync.ts": `import { fixtureAtom } from "fixture-atoms";
export const vaultSyncAtom = (key) => fixtureAtom("sync:" + key.app);`,
  "components/dashboard-bindings.tsx": `import { fixtureAtom, pendingAtom } from "fixture-atoms";
export const HostedFailure = () => null;
export const useDashboardAtoms = () => ({
  catalog: fixtureAtom("catalog"),
  inventory: fixtureAtom("inventory"),
  install: () => pendingAtom,
});`,
  "components/organization.tsx": `export const useOrganizationRoute = () => ({
  organization: "org_fixture",
  slug: "fixture",
});`,
};

/**
 * Bundle `exports` (export statements resolved from the hosted pages directory) with React, the
 * atom registry and the dashboard provider, register a virtual DOM, and load the bundle.
 */
export async function loadHostedPages(exports) {
  const scratch = mkdtempSync(join(tmpdir(), "hosted-render-"));
  const result = await build({
    stdin: {
      contents: [
        ...exports,
        'export { DashboardProvider } from "@executor-js/ui/dashboard/context";',
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
  const bundle = join(scratch, "hosted-pages.mjs");
  writeFileSync(bundle, result.outputFiles[0].text);
  const require = createRequire(join(web, "package.json"));
  const { GlobalRegistrator } = await import(
    pathToFileURL(require.resolve("@happy-dom/global-registrator")).href
  );
  GlobalRegistrator.register();
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
  const ui = await import(pathToFileURL(bundle).href);

  /**
   * Render `element(ui)` inside the registry and dashboard providers with these query results
   * (keyed like the replaced atoms; any other query stays pending), run `read` on the mounted
   * container, then unmount.
   */
  const render = async (results, element, read) => {
    ui.resetFixtureAtoms();
    globalThis.hostedFixture = { read: (key) => results[key] ?? ui.AsyncResult.initial() };
    const AppLink = ({ app: id, view, tool: _tool, children, ...props }) =>
      ui.createElement("a", { ...props, href: `#${id}${view ? `/${view}` : ""}` }, children);
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
              catalogIcons: ui.Atom.make({
                settled: true,
                byPackage: new Map(),
                byName: new Map(),
              }),
            },
            element(ui),
          ),
        ),
      );
    });
    const result = await read(container);
    await ui.act(async () => root.unmount());
    container.remove();
    return result;
  };

  const cleanup = async () => {
    await GlobalRegistrator.unregister();
    rmSync(scratch, { recursive: true, force: true });
  };
  return { ui, render, cleanup };
}
