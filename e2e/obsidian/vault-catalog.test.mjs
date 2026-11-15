// Another vault is another Obsidian app: the hosted Add app page, rendered for real with the
// catalog's own Obsidian entry, names copies after the entry's noun, and a vault's Accounts tab
// links straight into that entry's Add another.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { obsidian } from "../../src/catalog/obsidian/index.ts";
import { loadHostedPages } from "./render-tests/hosted-render.mjs";
import { app, vaultConnection } from "./render-tests/vault-fixtures.mjs";

let hosted;
let ui;
before(async () => {
  hosted = await loadHostedPages([
    'export { AddAppPage } from "./add-app.tsx";',
    'export { VaultDevicesSection } from "./obsidian-devices.tsx";',
    'export { obsidianCatalogEntry, obsidianTools } from "../../contracts/obsidian-connection.ts";',
    'export { parseAddAppSearch } from "../../contracts/navigation.ts";',
  ]);
  ({ ui } = hosted);
});
after(() => hosted?.cleanup(), { timeout: 10_000 });

const vault = { ...obsidian.entry, icons: [] };
// Services whose catalog entries name no noun for their copies; nothing is installed from notes.
const service = (id, name) => ({ id, package: id, name, description: name, auth: [], icons: [] });
const tracker = service("tracker", "Tracker");
const notes = service("notes", "Notes");
// Copies list oldest first, so each is created a day after the one before.
let created = Date.parse("2026-11-01T08:00:00.000Z");
const copy = (id, name, entry) => ({
  ...app(id, name, true),
  createdAt: new Date((created += 24 * 60 * 60 * 1000)),
  service: { id: entry.package, newInstance: true },
});
const installed = [
  copy("app_fixture_personal", "Personal", vault),
  copy("app_fixture_work", "Work", vault),
  copy("app_fixture_reading", "Reading", vault),
  copy("app_fixture_board", "Board", tracker),
  copy("app_fixture_backlog", "Backlog", tracker),
];
const success = (value) => ui.AsyncResult.success(value);
const results = () => ({
  catalog: success([vault, tracker, notes]),
  inventory: success({ apps: installed, links: [], accounts: [] }),
});
const text = (node) => node?.textContent?.replace(/\s+/g, " ").trim();

/**
 * Mount the hosted Add app page, as a link with these search parameters opens it, optionally act
 * on it, and read the catalog rows and any open dialog.
 */
const addApp = (search, act = async () => {}) =>
  hosted.render(
    results(),
    (ui) => ui.createElement(ui.AddAppPage, ui.parseAddAppSearch(search)),
    async (container) => {
      await act(container);
      const dialog = document.querySelector('[role="dialog"]');
      const input = dialog?.querySelector("input");
      return {
        rows: [...container.querySelectorAll(".catalog-row-title > div")].map((row) =>
          [...row.children].map(text),
        ),
        menu: [...document.querySelectorAll('[role="menuitem"]')].map(text),
        title: text(dialog?.querySelector("h2")),
        description: text(dialog?.querySelector("p")),
        field: text(dialog?.querySelector("label")),
        hint: text(document.getElementById(input?.getAttribute("aria-describedby") ?? "")),
        submit: text(dialog?.querySelector('button[type="submit"]')),
      };
    },
  );

test("the catalog counts a service's copies by the noun its entry gives them, and names them", async () => {
  const result = await addApp({});
  assert.deepEqual(result.rows, [
    ["Obsidian", "3 vaults added · Personal, Work, Reading"],
    ["Tracker", "2 added · Board, Backlog"],
    ["Notes"],
  ]);
});

test("an added vault's row menu offers Add another vault", async () => {
  const result = await addApp({}, async (container) => {
    const more = container.querySelector('[aria-label="More actions for Obsidian"]');
    await ui.act(async () => {
      more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      more.click();
    });
  });
  assert.deepEqual(result.menu, ["Add another vault"]);
});

test("a vault's Add another names a vault, the vaults it copies nothing from, and asks for its name", async () => {
  const result = await addApp({ entry: ui.obsidianCatalogEntry, another: true });
  assert.equal(result.title, "Add another Obsidian vault");
  assert.equal(
    result.description,
    "A separate vault with its own name, set up the way Obsidian always is. It starts empty: nothing is copied from Personal, Work or Reading.",
  );
  // The guidance describes the field without becoming part of its name.
  assert.equal(result.field, "Vault name");
  assert.equal(result.hint, "Use the vault's name in Obsidian. The app is named after it.");
  assert.equal(result.submit, "Add vault");
});

test("a service without a noun keeps the generic Add another copy", async () => {
  const result = await addApp({ entry: "tracker", another: true });
  assert.equal(result.title, "Add another Tracker");
  assert.equal(result.field, "Name");
  assert.equal(result.hint, undefined);
  assert.equal(result.submit, "Add");
});

test("a link opens Add another only for an entry with a copy to add another of", async () => {
  assert.equal((await addApp({ another: true })).title, undefined);
  assert.equal((await addApp({ entry: "notes", another: true })).title, undefined);
  assert.equal((await addApp({ entry: "obsidian", another: "true" })).title, undefined);
  assert.deepEqual(ui.parseAddAppSearch({ another: true }), {
    entry: undefined,
    another: undefined,
  });
});

test("a vault's Accounts tab links to Add another for the Obsidian entry", async () => {
  const personal = installed[0];
  const href = await hosted.render(
    {
      "tools:app_fixture_personal": success(ui.obsidianTools.map((name) => ({ name }))),
      connections: success([vaultConnection(personal, "conn_fixture_mac", ui.obsidianTools)]),
      agents: success([]),
    },
    (ui) => ui.createElement(ui.VaultDevicesSection, { app: personal }),
    (container) =>
      [...container.querySelectorAll("a")]
        .find((link) => text(link) === "Add another vault")
        ?.getAttribute("href"),
  );
  const search = Object.fromEntries(new URL(href, "https://fixture.invalid").searchParams);
  // The router reads search values as JSON, so the link's flag arrives as `true`.
  assert.deepEqual(
    ui.parseAddAppSearch({ entry: search.entry, another: JSON.parse(search.another) }),
    { entry: obsidian.entry.id, another: true },
  );
});
