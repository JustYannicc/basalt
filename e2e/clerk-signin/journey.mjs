import assert from "node:assert/strict";
import { Effect } from "effect";
import { Browser } from "../../.upstream/e2e/support/browser.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { scenarioEvidence, Telemetry } from "../../.upstream/e2e/support/evidence.ts";
import { RecordingFocus } from "../../.upstream/e2e/support/recording-focus.ts";
import { managementBrowser } from "../management-signin/browser.mjs";
import { verifyOnboardingRecovery } from "./onboarding-recovery.mjs";

export const clerkJourney = ({
  width,
  request,
  phase,
  session,
  target,
  server,
  api,
  prefix,
  app,
  retained,
  fixture,
  actors,
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.login(session);
    yield* browser.use(`Open Clerk at ${width}`, async (page) => {
      const stylesheetFailures = [];
      page.on("requestfailed", (request) => {
        if (request.resourceType() === "stylesheet")
          stylesheetFailures.push({
            url: request.url(),
            failure: request.failure()?.errorText,
          });
      });
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
      await page.waitForFunction(() => {
        const styles = [...document.querySelectorAll('link[rel="stylesheet"]')];
        return styles.length > 0 && styles.every((link) => link.sheet !== null);
      });
      assert.deepEqual(stylesheetFailures, [], "The visual proof requires every stylesheet");
      assert.match(
        await page.locator("body").evaluate((body) => getComputedStyle(body).fontFamily),
        /Geist|sans-serif/i,
      );
      const region = page.getByRole("region", { name: "Your accounts", exact: true });
      await region
        .getByRole("button", {
          name:
            phase === "signin" ? "Connect new account for Clerk · Sign in" : "Connect new account",
          exact: true,
        })
        .first()
        .click();
      const dialog = page.getByRole("dialog", { name: /^Connect Clerk(?: · Sign in)?$/ });
      await dialog.locator("form").waitFor();
      await page.waitForFunction(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog && getComputedStyle(dialog).opacity === "1";
      });
    });
    yield* browser.checkpoint(`Clerk before guidance ${width}`);
    if (phase === "signin" || phase === "baseline") {
      yield* browser.use("Clerk offers official sign-in and its key alternative", async (page) => {
        const dialog = page.getByRole("dialog", { name: /^Connect Clerk(?: · Sign in)?$/ });
        assert.equal(
          await dialog.getByRole("button", { name: "Sign in with Clerk", exact: true }).count(),
          1,
          "Clerk must start with official management sign-in",
        );
        await dialog.getByRole("button", { name: "Use an API key instead", exact: true }).click();
        await dialog.locator('input[type="password"]').waitFor();
      });
    }
    yield* browser.use("The API key has a usable setup guide", async (page) => {
      const dialog = page.getByRole("dialog", { name: /^Connect Clerk(?: · Sign in)?$/ });
      assert.equal(
        await dialog.getByRole("link", { name: "Open Clerk API keys", exact: true }).count(),
        1,
        "Clerk API-key setup must link to the exact dashboard page",
      );
      assert.equal(
        await dialog.getByLabel("Secret key", { exact: true }).count(),
        1,
        "The Clerk key field must name the required key",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        "No horizontal overflow",
      );
    });
    yield* browser.checkpoint(`Clerk API key ${width}`);
    if (phase === "signin") {
      const saved = (rows) =>
        rows
          .map((row) => [row.id, row.provider, row.method, row.label])
          .sort((left, right) => left[0].localeCompare(right[0]));
      const savedBefore = saved(yield* request("GET", `${prefix}/resources/accounts`));
      yield* browser.use("Return to sign-in without creating an account", async (page) => {
        await page.getByRole("button", { name: "Sign in instead", exact: true }).click();
        await page.getByRole("button", { name: "Sign in with Clerk", exact: true }).waitFor();
      });
      yield* browser.omitNetworkTrace;
      for (const decision of [
        "Cancel sign-in",
        "Refuse access",
        "Deny by policy",
        "Refuse with service code",
      ]) {
        yield* browser.use(`Clerk ${decision}`, async (page) => {
          await page.getByRole("button", { name: "Sign in with Clerk", exact: true }).click();
          await page.getByRole("heading", { name: "Clerk test workspace", exact: true }).waitFor();
          await page.getByRole("button", { name: decision, exact: true }).click();
          const dialog = page.getByRole("dialog", { name: "Connect Clerk", exact: true });
          await dialog.getByRole("button", { name: "Sign in with Clerk", exact: true }).waitFor();
          await dialog
            .getByText(
              decision === "Cancel sign-in" ? "Sign-in was cancelled." : "Access was declined.",
              { exact: true },
            )
            .waitFor();
          assert.equal(await page.getByText("Update client details", { exact: true }).count(), 0);
          await dialog
            .getByRole("button", { name: "Use an API key instead", exact: true })
            .waitFor();
        });
        yield* browser.checkpoint(`${decision} ${width}`);
        const links = yield* request("GET", `${prefix}/apps/${app.id}/accounts/user`);
        assert.equal(
          links.filter((link) => link.requirement === "signIn").length,
          0,
          "Cancellation and refusal save no account",
        );
        assert.deepEqual(
          saved(yield* request("GET", `${prefix}/resources/accounts`)),
          savedBefore,
          "Cancellation and refusal leave saved accounts unchanged",
        );
        yield* browser.use(
          "The key alternative remains reversible after a refusal",
          async (page) => {
            await page.getByRole("button", { name: "Use an API key instead", exact: true }).click();
            await page.getByLabel("Secret key", { exact: true }).waitFor();
            await page.getByRole("button", { name: "Sign in instead", exact: true }).click();
            await page.getByRole("button", { name: "Sign in with Clerk", exact: true }).waitFor();
          },
        );
      }
      yield* browser.use("Complete Clerk authorization through the real callback", async (page) => {
        await page.getByRole("button", { name: "Sign in with Clerk", exact: true }).click();
        await page.getByRole("button", { name: "Approve access", exact: true }).click();
        const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
        await naming.getByLabel("Account name", { exact: true }).fill(`Clerk ${width}`);
        await naming.getByRole("button", { name: "Save name", exact: true }).click();
        await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
      });
      yield* browser.checkpoint(`Clerk sign-in complete ${width}`);
      const links = yield* request("GET", `${prefix}/apps/${app.id}/accounts/user`);
      const signedIn = links.filter((link) => link.requirement === "signIn");
      assert.equal(signedIn.length, 1, "Approval saves and links exactly one OAuth account");
      const account = signedIn[0].account;
      assert.equal(account.method, "oauth");
      const health = yield* request("POST", `${prefix}/accounts/${account.id}/health`);
      assert.equal(health.apps.find((check) => check.app === app.id)?.check?.status, "healthy");
      const read = yield* request("POST", `${prefix}/apps/${app.id}/tools/call`, {
        tool: "list_organizations",
        input: { accountId: account.id, input: {} },
      });
      assert.equal(read.isError ?? false, false);
      assert.deepEqual(JSON.parse(read.content.find((item) => item.type === "text").text), {
        transport: "mcp",
        tool: "list_organizations",
      });
      const mutation = yield* api.request(session, "POST", `${prefix}/apps/${app.id}/tools/call`, {
        tool: "delete_organization",
        input: { accountId: account.id, input: {} },
      });
      assert.equal(mutation.status, 409, "MCP mutations need approval");
      assert.equal(mutation.body._tag, "ToolApprovalRequired");
      const restMutation = yield* api.request(
        session,
        "POST",
        `${prefix}/apps/${app.id}/tools/call`,
        { tool: "fixture.write", input: { accountId: retained.account.id, input: {} } },
      );
      assert.equal(restMutation.status, 409, "Retained REST mutations still need approval");
      assert.equal(restMutation.body._tag, "ToolApprovalRequired");
      const wrongAccount = yield* api.request(
        session,
        "POST",
        `${prefix}/apps/${app.id}/tools/call`,
        { tool: "list_organizations", input: { accountId: retained.account.id, input: {} } },
      );
      assert.equal(wrongAccount.status, 422, "An API key cannot authorize MCP tools");
      assert.equal(
        fixture.provider.calls.some((call) => call.tool === "delete_organization"),
        false,
      );
      assert.deepEqual(yield* retained.read(), { transport: "rest", retainedKey: true });
      yield* request("DELETE", `${prefix}/apps/${app.id}/accounts/user/signIn/${account.id}`);
      yield* request("DELETE", `${prefix}/accounts/${account.id}`);
      const beforeManual = saved(yield* request("GET", `${prefix}/resources/accounts`));
      yield* verifyOnboardingRecovery(browser, actors.organization.slug, width);
      assert.deepEqual(
        saved(yield* request("GET", `${prefix}/resources/accounts`)),
        beforeManual,
        "Onboarding refusal saves no account",
      );
    }
  }).pipe(
    Effect.timeout("60 seconds"),
    Effect.scoped,
    Effect.provide(Browser.layer),
    Effect.provide(
      scenarioEvidence({ file: "e2e/clerk-sign-in.mjs", name: `Clerk guidance ${width}` }),
    ),
    Effect.provide(Telemetry.layer),
    Effect.provide(RecordingFocus.layer),
    Effect.provide(managementBrowser(server.tlsCertificate)),
    Effect.provideService(Target, target),
  );
