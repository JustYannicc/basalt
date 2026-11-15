// The hosted Apps page, rendered for real: each vault's card shows the devices its Accounts tab
// lists, and every other app keeps the shared copy.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadHostedPages } from "./render-tests/hosted-render.mjs";
import { ago, app, device, hour, vaultConnection } from "./render-tests/vault-fixtures.mjs";

let hosted;
let ui;
before(async () => {
  hosted = await loadHostedPages([
    'export { AppsPage } from "./apps.tsx";',
    'export { obsidianTools } from "../../contracts/obsidian-connection.ts";',
  ]);
  ({ ui } = hosted);
});
after(() => hosted?.cleanup(), { timeout: 10_000 });

const vault = app("app_fixture_vault", "Obsidian", true);
const notes = app("app_fixture_notes", "Notes", true);
const weather = app("app_fixture_weather", "Weather", false);
const mac = (lastActiveAt) => device("grant_fixture_mac", "conn_fixture_mac", lastActiveAt);
const success = (value) => ui.AsyncResult.success(value);
const failed = () => ui.AsyncResult.failure(ui.Cause.fail(new Error("unavailable")));
const tools = (names) => success(names.map((name) => ({ name })));

/** Mount the hosted Apps page and return each card's footer text. */
const cards = (results) =>
  hosted.render(
    {
      inventory: success({ apps: [vault, notes, weather], links: [], accounts: [] }),
      groups: success({ groups: [] }),
      ...results,
    },
    (ui) => ui.createElement(ui.AppsPage),
    (container) => {
      const card = (name) => container.querySelector(`[aria-label^="Open ${name}"]`);
      const text = (name) =>
        card(name)?.querySelector(".app-card-footer")?.textContent?.replace(/\s+/g, " ").trim();
      // The warning color is how the card says a vault needs a look.
      const warned = (name) =>
        card(name)?.querySelector(".app-card-footer .text-sign-in-warning") !== null;
      return {
        warned: warned("Obsidian"),
        vault: text("Obsidian"),
        notes: text("Notes"),
        weather: text("Weather"),
        loading: container.querySelectorAll('[aria-label="Loading status"]').length,
        // The line under each card's name, by name.
        subtitles: Object.fromEntries(
          [...container.querySelectorAll(".app-card-heading strong")].map((name) => [
            name.textContent,
            name.nextElementSibling?.textContent ?? null,
          ]),
        ),
      };
    },
  );

const settled = (agents, extra = {}) => ({
  "tools:app_fixture_vault": tools(ui.obsidianTools),
  "tools:app_fixture_notes": tools(["read", "write"]),
  connections: success([vaultConnection(vault, "conn_fixture_mac", ui.obsidianTools)]),
  agents: success(agents),
  ...extra,
});

test("a vault with a connected device says so instead of 'No account required'", async () => {
  const result = await cards(settled([mac(ago(26 * hour))]));
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
  const result = await cards(
    settled([mac(ago(26 * hour))], {
      "tools:app_fixture_vault": tools([...ui.obsidianTools, "devices"]),
      "sync:app_fixture_vault": success({
        head: "h2",
        devices: [{ agent: "grant_fixture_mac", lastSyncAt: ago(2 * 60 * 1000), lastHead: "h2" }],
      }),
    }),
  );
  assert.match(result.vault ?? "", /^1 device · synced /);
});

test("a vault whose newest device has been idle more than two days says when it was last seen", async () => {
  const stale = await cards(settled([mac(ago(3 * 24 * hour))]));
  assert.match(stale.vault ?? "", /^1 device · last active /);
  assert.equal(stale.warned, true);
  const fresh = await cards(settled([mac(ago(47 * hour))]));
  assert.match(fresh.vault ?? "", /^1 device · active /);
  assert.equal(fresh.warned, false);
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
  const result = await cards({ ...settled([]), agents: failed() });
  assert.equal(result.vault, "Status couldn't be loaded");
  assert.equal(result.notes, "No account required");
});

test("a drive app whose tools can't be read never claims devices or 'No account required'", async () => {
  const result = await cards({
    ...settled([]),
    "tools:app_fixture_vault": failed(),
    "tools:app_fixture_notes": failed(),
  });
  assert.equal(result.vault, "Status couldn't be loaded");
  assert.equal(result.notes, "Status couldn't be loaded");
  assert.equal(result.weather, "No account required");
});

test("a vault is flagged only when even its newest device has been idle that long", async () => {
  const phone = device("grant_fixture_phone", "conn_fixture_phone", ago(hour));
  const result = await cards({
    ...settled([mac(ago(3 * 24 * hour)), phone]),
    connections: success([
      vaultConnection(vault, "conn_fixture_mac", ui.obsidianTools),
      vaultConnection(vault, "conn_fixture_phone", ui.obsidianTools),
    ]),
  });
  assert.match(result.vault ?? "", /^2 devices · active /);
  assert.equal(result.warned, false);
});

test("a renamed copy says which service it is a copy of, in the catalog's word for one", async () => {
  const service = (name, noun) => ({
    id: name.toLowerCase(),
    newInstance: true,
    name,
    ...(noun === undefined ? {} : { noun }),
  });
  const result = await cards({
    ...settled([]),
    inventory: success({
      apps: [
        { ...vault, service: service("Obsidian", "vault") },
        { ...app("app_fixture_personal", "Personal", true), service: service("Obsidian", "vault") },
        { ...app("app_fixture_board", "Board", false), service: service("Tracker") },
        notes,
      ],
      links: [],
      accounts: [],
    }),
  });
  assert.deepEqual(result.subtitles, {
    // Named after its service, so nothing to add.
    Obsidian: null,
    Personal: "Obsidian vault",
    Board: "Tracker",
    // No recorded service name: nothing to say.
    Notes: null,
  });
});

test("the built-in app shows the product's name and no subtitle, whatever the brand", async () => {
  const builtIn = {
    ...app("app_fixture_builtin", "Executor", false),
    copiedFrom: { name: "executor" },
    service: { id: "executor", newInstance: false, name: "Executor" },
  };
  const result = await hosted.render(
    {
      inventory: success({ apps: [builtIn], links: [], accounts: [] }),
      groups: success({ groups: [] }),
    },
    (ui) => ui.createElement(ui.AppsPage),
    (container) =>
      [...container.querySelectorAll(".app-card-heading strong")].map((name) => [
        name.textContent,
        name.nextElementSibling?.textContent ?? null,
      ]),
    { brand: { name: "Northwind", logo: "/favicon.png" } },
  );
  assert.deepEqual(result, [["Northwind", null]]);
});
