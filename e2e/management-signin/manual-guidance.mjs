import assert from "node:assert/strict";
import { Effect } from "effect";

const client = {
  steps: ["Create a client in the synthetic management workspace."],
  link: { label: "Open synthetic client settings", url: "https://localhost/oauth-clients" },
  fields: {
    clientId: { label: "Management client ID", expectedFormat: "Use the client_ identifier." },
    clientSecret: { label: "Management client secret" },
    region: { label: "Management region" },
  },
};

/** Extra publisher metadata exercises the reusable renderer without changing provider identity. */
export function withManualGuidance(feed) {
  return {
    ...feed,
    apps: feed.apps.map((entry) =>
      entry.id !== "workos"
        ? entry
        : {
            ...entry,
            connectionGuidance: [
              {
                requirement: "other",
                method: "oauth",
                oauthClient: {
                  ...client,
                  link: { ...client.link, label: "Wrong requirement guide" },
                },
              },
              {
                requirement: "signIn",
                method: "other",
                oauthClient: { ...client, link: { ...client.link, label: "Wrong method guide" } },
              },
              ...entry.connectionGuidance.map((guide) =>
                guide.requirement === "signIn" && guide.method === "oauth"
                  ? { ...guide, oauthClient: client }
                  : guide,
              ),
            ],
          },
    ),
  };
}

export function verifyManualGuidance(browser, width) {
  return Effect.gen(function* () {
    yield* browser.use("Manual client guidance follows the selected OAuth client", async (page) => {
      const region = page.getByRole("region", { name: "Your accounts", exact: true });
      // WorkOS's sign-in and API key requirements share one section and one connect menu.
      await region
        .getByRole("region", { name: "WorkOS", exact: true })
        .getByRole("button", { name: "Connect new account", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Sign in with WorkOS", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /^Connect WorkOS(?: · Sign in)?$/ });
      await dialog.getByRole("button", { name: "Sign in with WorkOS", exact: true }).waitFor();
      assert.equal(
        await dialog
          .getByRole("link", { name: "Open synthetic client settings", exact: true })
          .count(),
        0,
      );
      await dialog.getByText("Advanced", { exact: true }).click();
      const select = dialog.getByRole("combobox", { name: "OAuth client", exact: true });
      await select.click();
      await page.getByRole("option", { name: "Your own WorkOS app (OAuth)", exact: true }).click();
      await dialog
        .getByRole("link", { name: "Open synthetic client settings", exact: true })
        .waitFor();
      assert.equal(
        await dialog.getByRole("link", { name: /Wrong (requirement|method) guide/ }).count(),
        0,
      );
      const id = dialog.getByLabel("Management client ID", { exact: true });
      await id.fill("client_synthetic_manual");
      assert.equal(
        await dialog.getByText("Use the client_ identifier.", { exact: true }).count(),
        1,
      );
      assert.equal(
        await dialog.getByLabel("Management region", { exact: true }).count(),
        0,
        "Guidance cannot declare a new region input",
      );
      assert.equal(
        await dialog.getByLabel("Management client secret", { exact: true }).count(),
        0,
        "Public-client metadata must not create a secret input",
      );
      await select.click();
      await page
        .getByRole("option")
        .filter({ hasText: /automatic/ })
        .click();
      assert.equal(
        await dialog
          .getByRole("link", { name: "Open synthetic client settings", exact: true })
          .count(),
        0,
      );
      await select.click();
      await page.getByRole("option", { name: "Your own WorkOS app (OAuth)", exact: true }).click();
      assert.equal(
        await id.inputValue(),
        "client_synthetic_manual",
        "Client values survive presentation changes",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    });
    yield* browser.checkpoint(`Manual OAuth client guidance ${width}`);
    yield* browser.use("Leave manual setup without saving an account", async (page) =>
      page.keyboard.press("Escape"),
    );
  });
}
