import assert from "node:assert/strict";
import { Effect } from "effect";

export const verifyOnboardingRecovery = (browser, organization, width) =>
  Effect.gen(function* () {
    yield* browser.use("Start Clerk sign-in from onboarding", async (page) => {
      await page.goto(`/org/${organization}/setup/accounts`);
      await page.getByRole("heading", { name: "Connect your accounts", exact: true }).waitFor();
      await page
        .getByRole("group", { name: "Clerk", exact: true })
        .getByRole("button", { name: /^(Connect|Add)/ })
        .click();
      await page.getByRole("button", { name: "Sign in with Clerk", exact: true }).click();
      await page.getByRole("button", { name: "Deny by policy", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Connect Clerk", exact: true });
      await dialog
        .getByText(
          "Your Clerk workspace has disabled sign-in for connected tools. Ask a workspace admin to review access.",
          { exact: true },
        )
        .waitFor();
      assert.ok(new URL(page.url()).pathname.endsWith("/setup/accounts"));
      assert.equal(await page.getByText("Update client details", { exact: true }).count(), 0);
      await dialog.getByRole("button", { name: "Sign in with Clerk", exact: true }).waitFor();
    });
    yield* browser.checkpoint(`Onboarding refusal recovery ${width}`);
    yield* browser.use("Onboarding keeps reversible connection choices", async (page) => {
      const dialog = page.getByRole("dialog", { name: "Connect Clerk", exact: true });
      await dialog.getByRole("button", { name: "Use an API key instead", exact: true }).click();
      await dialog.getByLabel("Secret key", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Sign in instead", exact: true }).click();
      await dialog.getByRole("button", { name: "Sign in with Clerk", exact: true }).waitFor();
    });
    yield* browser.use("Dismiss onboarding recovery", async (page) => {
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    });
  });
