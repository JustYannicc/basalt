import assert from "node:assert/strict";
import { Effect } from "effect";
import { appsVersion } from "../../.upstream/e2e/support/apps-release.ts";

export const instanceGuideEntry = {
  id: "instance-guide",
  package: "@fixture/instance-guide",
  name: "Instance guide",
  description: "Synthetic selected-instance guidance.",
  auth: [{ method: "key", kind: "secrets", label: "Personal token" }],
  icons: [],
  source: "apps/instance-guide.json",
  connectionGuidance: [
    {
      requirement: "service",
      method: "key",
      credentials: {
        steps: ["Create a token on the selected service instance."],
        link: {
          label: "Open this instance's token settings",
          url: "/-/user_settings/personal_access_tokens",
        },
        fields: { token: { label: "Personal token" } },
      },
    },
  ],
};

export const instanceGuideSource = {
  package: instanceGuideEntry.package,
  files: [
    {
      path: "package.json",
      content: JSON.stringify({
        name: instanceGuideEntry.package,
        dependencies: { apps: appsVersion },
      }),
    },
    {
      path: "index.ts",
      content: `import {defineApp, defineProvider, secrets, oauth2, object, string, router} from "apps";
const service = defineProvider({name: "Instance guide", site: {label: "Service instance", origin: "https://one.example.test"},
  hosts: ["one.example.test"], auth: {key: secrets({label: "Personal token", fields: object({token: string({minLength: 1})})}), oauth: oauth2({authorizationUrl: "https://one.example.test/authorize", tokenUrl: "https://one.example.test/token", tokenEndpointAuthMethod: "none", scopes: ["read", "write"]})}});
export default defineApp({user: {accounts: {service: service.many()}}}, () => ({tools: router({})}));`,
    },
  ],
};

/** The same root-relative guide follows two chosen origins, without visiting either service. */
export const verifyInstanceGuidance = (browser, app) =>
  Effect.gen(function* () {
    for (const origin of ["https://first.example.test", "https://second.example.test"]) {
      yield* browser.use("Open token guidance for a selected service instance", async (page) => {
        await page.goto(`/apps/${app}?view=accounts`);
        await page.getByRole("button", { name: "Connect new account", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("Service instance", { exact: true }).fill(origin);
        await dialog.getByRole("button", { name: "Continue", exact: true }).click();
        const method = dialog.getByRole("combobox", { name: "Sign-in method", exact: true });
        await method.waitFor();
        assert.equal(
          await method.textContent(),
          "Sign in with Instance guide",
          "OAuth stays first even when the provider declares its key first and has no OAuth guide",
        );
        await method.click();
        await page.getByRole("option", { name: "Personal token", exact: true }).click();
        await dialog.getByLabel("Personal token", { exact: true }).waitFor();
        assert.equal(
          await dialog
            .getByRole("link", { name: "Open this instance's token settings", exact: true })
            .getAttribute("href"),
          `${origin}/-/user_settings/personal_access_tokens`,
        );
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
      });
    }
  });
