import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "./dependencies.mjs";
import { Browser } from "../../.upstream/e2e/support/browser.ts";
import { assertPrivate } from "./fixture.mjs";

/** Read persisted health through both dashboards at phone width, then use their existing recovery. */
export const proveRecoveryUi = ({
  target,
  actors,
  app,
  label,
  directory,
  name,
  reason,
  reconnect,
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const screenshots = [];
    const capture = async (page, suffix) => {
      assertPrivate(await page.locator("body").innerText());
      const filename = `${name}-${suffix}-390.png`;
      const path = join(directory, filename);
      await page.screenshot({ path, animations: "disabled", fullPage: true });
      await chmod(path, 0o600);
      screenshots.push(filename);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, "Account recovery page overflows a 390px viewport");
    };
    const menuButton = (page) =>
      page
        .getByRole("button", {
          name: new RegExp(`^Manage ${label}(?: in .+)?$`),
        })
        .first();
    const row = (page) =>
      page
        .locator(".inventory-row")
        .filter({ has: menuButton(page) })
        .first();
    const details = async (page) => {
      await menuButton(page).click();
      await capture(page, "manage");
      await page.getByRole("menuitem", { name: "Details", exact: true }).click();
      const detail = row(page).locator("[data-account-details]");
      await detail.waitFor({ state: "visible" });
      const message = detail.locator("[data-check-message]");
      await message.first().waitFor({ state: "visible" });
      assert.match(await message.allTextContents().then((parts) => parts.join(" ")), reason);
      if (name !== "invalid-grant") {
        const protocol = detail.locator("[data-check-evidence]");
        await protocol.first().waitFor({ state: "visible" });
        const text = await protocol.allTextContents().then((parts) => parts.join(" "));
        assert.match(text, /OAuth refresh/);
        assert.match(text, name === "service-503" ? /HTTP 503/ : /HTTP 400.*invalid_request/);
      }
      await capture(page, "details");
    };

    yield* browser.use(`Inspect ${name} in global Accounts at 390px`, async (page) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/org/${actors.organization.slug}/accounts`);
      await menuButton(page).waitFor({ state: "visible" });
      await details(page);
      if (reconnect) {
        await menuButton(page).click();
        const recovery = page.getByRole("menuitem", { name: /^Reconnect in / });
        await recovery.waitFor({ state: "visible" });
        await capture(page, "global-reconnect-menu");
        await recovery.click();
        await page.waitForURL(`**/apps/${app.id}?view=accounts`);
      }
    });

    return yield* browser.use(`Inspect ${name} in app Accounts and recover`, async (page) => {
      if (!reconnect)
        await page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
      await menuButton(page).waitFor({ state: "visible" });
      const accountRow = page;
      await accountRow.locator("[data-account-health-cell]").first().waitFor({ state: "visible" });
      const inline = accountRow.getByRole("button", { name: "Reconnect", exact: true });
      if (!reconnect) {
        assert.equal(await inline.count(), 0, "A service outage must not offer inline Reconnect");
        await capture(page, "app-row");
        return { screenshots, reconnectOffered: false };
      }
      await inline.waitFor({ state: "visible" });
      await capture(page, "app-row-reconnect");
      await inline.click();
      const dialog = page.getByRole("dialog", { name: "Reconnect Renewal fixture", exact: true });
      await dialog.waitFor({ state: "visible" });
      await capture(page, "reconnect-dialog");
      const completed = page.context().waitForEvent("response", {
        predicate: (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/oauth/complete"),
      });
      await dialog.getByRole("button", { name: "Reconnect Renewal fixture", exact: true }).click();
      const response = await completed;
      assert.equal(response.status(), 200, "Existing OAuth reconnect did not complete");
      const account = await response.json();
      assertPrivate(account);
      await dialog.waitFor({ state: "hidden" });
      await menuButton(page).waitFor({ state: "visible" });
      assert.equal(
        await page.getByRole("dialog", { name: "Name this account", exact: true }).count(),
        0,
      );
      await capture(page, "reconnected");
      return { screenshots, reconnectOffered: true, accountId: account.id };
    });
  });

/** Retain the old dashboard before the new evidence assertion fails against the baseline SDK. */
export const captureBeforeUi = ({ actors, directory, label, legacy = false }) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Retain renewal baseline at 390px", async (page) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/org/${actors.organization.slug}/accounts`);
      const manage = page
        .getByRole("button", { name: new RegExp(`^Manage ${label}(?: in .+)?$`) })
        .first();
      await manage.waitFor({ state: "visible" });
      await manage.click();
      await page.screenshot({
        path: join(directory, "before-menu-390.png"),
        animations: "disabled",
        fullPage: true,
      });
      await page.getByRole("menuitem", { name: "Details", exact: true }).click();
      const detail = page
        .locator(".inventory-row")
        .filter({ has: manage })
        .locator("[data-account-details]");
      await detail.waitFor({ state: "visible" });
      if (legacy) {
        assert.match(await detail.innerText(), /Could not renew sign-in/);
        assert.match(await detail.innerText(), /No reason was recorded/);
        await detail.getByRole("link", { name: /^Reconnect in / }).waitFor({ state: "visible" });
      }
      assertPrivate(await page.locator("body").innerText());
      await page.screenshot({
        path: join(directory, "before-details-390.png"),
        animations: "disabled",
        fullPage: true,
      });
    });
  });
