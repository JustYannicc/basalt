// A vault app's Accounts tab, rendered for real: the hosted section and tab count inside the
// shared app layout, reading the same devices the vault's Apps card summarises.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadHostedPages } from "./render-tests/hosted-render.mjs";
import { ago, app, device, hour, vaultConnection } from "./render-tests/vault-fixtures.mjs";

let hosted;
let ui;
before(async () => {
  hosted = await loadHostedPages([
    'export { VaultDeviceCount, VaultDevicesSection } from "./obsidian-devices.tsx";',
    'export { AppDetailLayout } from "@executor-js/ui/dashboard/app-detail";',
    'export { obsidianTools } from "../../contracts/obsidian-connection.ts";',
  ]);
  ({ ui } = hosted);
});
after(() => hosted?.cleanup(), { timeout: 10_000 });

const personal = app("app_fixture_personal", "Personal", true);
const weather = app("app_fixture_weather", "Weather", false);
const success = (value) => ui.AsyncResult.success(value);
const vaultResults = (agents) => ({
  "tools:app_fixture_personal": success(ui.obsidianTools.map((name) => ({ name }))),
  connections: success([
    vaultConnection(personal, "conn_fixture_mac", ui.obsidianTools),
    vaultConnection(personal, "conn_fixture_phone", ui.obsidianTools),
  ]),
  agents: success(agents),
});

/** Mount an app's Accounts tab as the hosted page lays it out. */
const accountsTab = (current, results) =>
  hosted.render(
    results,
    (ui) =>
      ui.createElement(
        ui.AppDetailLayout,
        {
          app: current,
          view: "accounts",
          canInspectSource: false,
          back: null,
          badges: { accounts: ui.createElement(ui.VaultDeviceCount, { app: current }) },
        },
        ui.createElement(ui.VaultDevicesSection, { app: current }),
      ),
    (container) => {
      const tab = [...container.querySelectorAll('nav[aria-label="App navigation"] a')].find(
        (link) => link.getAttribute("href")?.endsWith("/accounts"),
      );
      const section = container.querySelector("section");
      const badge = tab?.querySelector("span");
      return {
        tab: tab?.textContent?.replace(/\s+/g, " ").trim(),
        // The count stays out of the tab's accessible name, which remains the section's name.
        badgeHidden: badge?.getAttribute("aria-hidden"),
        section: section?.getAttribute("aria-label"),
        heading: section?.querySelector("h2")?.textContent,
        rows: [...(section?.querySelectorAll("li") ?? [])].map((row) => ({
          name: row.querySelector("p")?.textContent,
          line: row.querySelectorAll("p")[1]?.textContent?.replace(/\s+/g, " ").trim(),
          disconnect: row.querySelector("button")?.textContent,
          // The warning color is how a row says its device needs a look.
          warned: row.querySelector(".text-sign-in-warning") !== null,
        })),
      };
    },
  );

test("a vault's Accounts tab names the vault and lists its devices with Disconnect", async () => {
  const result = await accountsTab(
    personal,
    vaultResults([
      device("grant_fixture_mac", "conn_fixture_mac", ago(4 * 60 * 1000), "MacBook Pro"),
      device("grant_fixture_phone", "conn_fixture_phone", ago(26 * hour)),
    ]),
  );
  assert.equal(result.heading, "Devices syncing Personal");
  assert.equal(result.section, "Devices syncing Personal");
  assert.deepEqual(
    result.rows.map((row) => row.name),
    ["MacBook Pro", "Obsidian device"],
  );
  assert.match(result.rows[0]?.line ?? "", /^Active .* · Connected /);
  assert.equal(result.rows[0]?.disconnect, "Disconnect MacBook Pro");
  // The tab counts the devices without changing the tab's name.
  assert.equal(result.tab, "Accounts2");
  assert.equal(result.badgeHidden, "true");
  assert.deepEqual(
    result.rows.map((row) => row.warned),
    [false, false],
  );
});

test("only a device idle more than two days is flagged, and says when it was last seen", async () => {
  const result = await accountsTab(
    personal,
    vaultResults([
      device("grant_fixture_mac", "conn_fixture_mac", ago(3 * 24 * hour)),
      device("grant_fixture_phone", "conn_fixture_phone", ago(hour)),
    ]),
  );
  assert.match(result.rows[0]?.line ?? "", /^Last active .* · Connected /);
  assert.match(result.rows[1]?.line ?? "", /^Active .* · Connected /);
  assert.deepEqual(
    result.rows.map((row) => row.warned),
    [true, false],
  );
});

test("an app that isn't a vault gets neither the section nor a count", async () => {
  const result = await accountsTab(weather, {});
  assert.equal(result.section, undefined);
  assert.equal(result.tab, "Accounts");
});
