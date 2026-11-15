// Accounts lists saved sign-ins. A vault's access is its devices, so a search that finds no saved
// sign-in points to the vaults it matches: the shared Accounts page, rendered for real with the
// search the hosted page gives it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadHostedPages } from "./render-tests/hosted-render.mjs";
import { ago, app, device, hour, vaultConnection } from "./render-tests/vault-fixtures.mjs";

let hosted;
let ui;
before(async () => {
  hosted = await loadHostedPages([
    'export { AccountsPage } from "@executor-js/ui/dashboard/accounts";',
    'export { vaultAccountsSearch } from "./obsidian-vault-search.tsx";',
    'export { obsidianTools } from "../../contracts/obsidian-connection.ts";',
  ]);
  ({ ui } = hosted);
});
after(() => hosted?.cleanup(), { timeout: 10_000 });

const personal = app("app_fixture_personal", "Personal", true);
const work = app("app_fixture_work", "Work", true);
const reading = app("app_fixture_reading", "Reading", true);
const notes = app("app_fixture_notes", "Notes", true);
const weather = app("app_fixture_weather", "Weather", false);
const mail = {
  id: "acct_fixture_mail",
  provider: "mail",
  label: "alex@work.fixture.invalid",
  createdAt: "2026-11-01T08:00:00.000Z",
};
const success = (value) => ui.AsyncResult.success(value);
const tools = (names) => success(names.map((name) => ({ name })));

const results = () => ({
  inventory: success({
    apps: [personal, work, reading, notes, weather],
    links: [],
    accounts: [mail],
  }),
  "tools:app_fixture_personal": tools(ui.obsidianTools),
  "tools:app_fixture_work": tools(ui.obsidianTools),
  "tools:app_fixture_reading": tools(ui.obsidianTools),
  "tools:app_fixture_notes": tools(["read", "write"]),
  connections: success([
    vaultConnection(personal, "conn_fixture_mac", ui.obsidianTools),
    vaultConnection(personal, "conn_fixture_phone", ui.obsidianTools),
    vaultConnection(work, "conn_fixture_air", ui.obsidianTools),
  ]),
  agents: success([
    device("grant_fixture_mac", "conn_fixture_mac", ago(hour)),
    device("grant_fixture_phone", "conn_fixture_phone", ago(2 * hour)),
    device("grant_fixture_air", "conn_fixture_air", ago(3 * 24 * hour)),
  ]),
});
const text = (node) => node?.textContent?.replace(/\s+/g, " ").trim();

/** Mount Accounts, type `search` into its search box, and read the page. */
const accounts = (search) =>
  hosted.render(
    results(),
    (ui) =>
      ui.createElement(ui.AccountsPage, {
        query: ui.Atom.make(results().inventory),
        Failure: () => null,
        searchElsewhere: ui.vaultAccountsSearch,
      }),
    async (container) => {
      const input = container.querySelector('input[type="search"], input');
      await ui.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, search);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const section = container.querySelector('section[aria-label="Obsidian vaults"]');
      return {
        empty: container.textContent.includes("No matching accounts"),
        // The section stays hidden until a vault matches.
        shown: section !== null && section.querySelector("li") !== null,
        rows: [...(section?.querySelectorAll("li a") ?? [])].map((row) => ({
          name: text(row.querySelector(".truncate")),
          // The row's own cells: icon, name, device state, arrow.
          state: text([...row.children].at(-2)),
          href: row.getAttribute("href"),
        })),
      };
    },
  );

test("a search no sign-in matches points to the vaults it names, with their devices", async () => {
  const result = await accounts("obs");
  assert.equal(result.empty, true);
  assert.equal(result.shown, true);
  assert.deepEqual(result.rows, [
    { name: "Personal", state: "2 devices", href: "#app_fixture_personal/accounts" },
    { name: "Work", state: "1 device · needs attention", href: "#app_fixture_work/accounts" },
    { name: "Reading", state: "No devices yet", href: "#app_fixture_reading/accounts" },
  ]);
});

test("a vault's own name finds it too, and other drive apps never appear", async () => {
  const result = await accounts("personal");
  assert.equal(result.empty, true);
  assert.deepEqual(
    result.rows.map((row) => row.name),
    ["Personal"],
  );
  const notesSearch = await accounts("notes");
  assert.equal(notesSearch.shown, false);
});

test("a search that names both a saved sign-in and a vault shows both", async () => {
  const result = await accounts("work");
  assert.equal(result.empty, false);
  assert.deepEqual(
    result.rows.map((row) => row.name),
    ["Work"],
  );
});

test("a search that names only saved sign-ins adds nothing", async () => {
  const result = await accounts("alex");
  assert.equal(result.empty, false);
  assert.equal(result.shown, false);
});
