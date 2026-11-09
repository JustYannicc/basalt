import assert from "node:assert/strict";
import { Effect } from "effect";
import { Browser } from "../../.upstream/e2e/support/browser.ts";
import { nameConnectedAccount } from "../../.upstream/e2e/support/name-account.ts";
import { restToken, restOAuthClient } from "./instance.mjs";

const dialogName = /^Connect GitLab(?: MCP)?(?: · .+)?$/;
const added = (before, after) =>
  after.filter((link) => !before.some((old) => old.account.id === link.account.id));
// Open the sign-in requirement and choose a self-managed instance in place of GitLab.com.
const openAt = async (page, origin) => {
  const region = page.getByRole("region", { name: "Your accounts", exact: true });
  // GitLab and GitLab MCP share one section, whose connect menu lists each method.
  await region
    .getByRole("region", { name: "GitLab", exact: true })
    .getByRole("button", { name: "Connect new account", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Sign in with GitLab MCP", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: dialogName });
  await dialog.getByText("Using https://gitlab.com", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Use another instance", exact: true }).click();
  await dialog.getByLabel("GitLab instance URL", { exact: true }).fill(origin);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByText(`Using ${origin}`, { exact: true }).waitFor();
  return dialog;
};
const noOverflow = async (page) =>
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "No horizontal overflow",
  );

/** The same connection and recovery journey at every supported browser width. */
export const verifyGitLabConnections = ({
  width,
  session,
  actors,
  app,
  automatic,
  manual,
  disabled,
  links,
  call,
  request,
  prefix,
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.login(session);
    yield* browser.use(`Open GitLab at ${width}`, async (page) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
      await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
    });
    yield* browser.use("Setup links follow each selected HTTPS instance", async (page) => {
      for (const origin of ["https://first.example.test", "https://second.example.test"]) {
        const dialog = await openAt(page, origin);
        await dialog
          .getByRole("button", {
            name: "Use a personal access token for the full API",
            exact: true,
          })
          .click();
        assert.equal(
          await dialog
            .getByRole("link", { name: "Open GitLab personal access tokens", exact: true })
            .getAttribute("href"),
          `${origin}/-/user_settings/personal_access_tokens`,
        );
        await dialog
          .getByRole("button", { name: "Use your own GitLab app for the full API", exact: true })
          .click();
        await dialog.getByText("Advanced", { exact: true }).click();
        await dialog
          .getByRole("checkbox", { name: "Use your own GitLab app for this account", exact: true })
          .check();
        assert.equal(
          await dialog
            .getByRole("link", { name: "Open GitLab applications", exact: true })
            .getAttribute("href"),
          `${origin}/-/user_settings/applications`,
        );
        await noOverflow(page);
        await page.keyboard.press("Escape");
      }
    });
    yield* browser.use("GitLab starts with MCP sign-in on the chosen instance", async (page) => {
      const dialog = await openAt(page, automatic.origin);
      await dialog.getByRole("button", { name: "Sign in with GitLab MCP", exact: true }).waitFor();
      await dialog.getByText(/Your administrator can turn off personal access tokens/).waitFor();
      await dialog
        .getByText("Sign in to use GitLab's MCP tools on this instance.", { exact: true })
        .waitFor();
      assert.equal(
        await dialog.getByRole("link", { name: /^Open GitLab/ }).count(),
        0,
        "Advertised registration needs no GitLab app setup",
      );
      await dialog.getByText("What does sign-in connect?", { exact: true }).click();
      await dialog.getByText(/none of the REST API tools/).waitFor();
      await noOverflow(page);
    });
    yield* browser.checkpoint(`GitLab sign-in ${width}`);
    yield* browser.use("A personal access token opens on the same instance", async (page) => {
      const dialog = page.getByRole("dialog", { name: dialogName });
      await dialog
        .getByRole("button", {
          name: "Use a personal access token for the full API",
          exact: true,
        })
        .click();
      await dialog.getByText(`Using ${automatic.origin}`, { exact: true }).waitFor();
      await dialog.getByLabel("Personal access token", { exact: true }).waitFor();
      const link = dialog.getByRole("link", {
        name: "Open GitLab personal access tokens",
        exact: true,
      });
      assert.equal(
        await link.count(),
        0,
        "HTTP fixture setup links stay hidden by the shared HTTPS policy",
      );
      assert.equal(await dialog.getByLabel("Personal access token", { exact: true }).count(), 1);
      await dialog.getByText("Paste the token only, without Bearer.", { exact: true }).waitFor();
      await dialog.getByText(/Select the api scope for full REST API access/).waitFor();
      await dialog
        .getByText(/Your administrator can turn off personal access tokens/)
        .first()
        .waitFor();
      await noOverflow(page);
    });
    yield* browser.checkpoint(`GitLab personal access token ${width}`);
    const tokensBefore = yield* links("gitlab");
    yield* browser.use("Save the token for the selected instance", async (page) => {
      const dialog = page.getByRole("dialog", { name: dialogName });
      await dialog.getByLabel("Personal access token", { exact: true }).fill(restToken);
      await dialog.locator('button[type="submit"]').click();
      await dialog.getByText("Signed in as synthetic", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Continue", exact: true }).click();
      const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
      await naming.getByLabel("Account name", { exact: true }).fill(`GitLab token ${width}`);
      await naming.getByRole("button", { name: "Save name", exact: true }).click();
      await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
    });
    const [token] = added(tokensBefore, yield* links("gitlab"));
    assert.ok(token, "The token saves and links one REST account");
    assert.equal(token.account.method, "token");
    assert.equal(token.account.site, automatic.origin);
    const tokenHealth = yield* request("POST", `${prefix}/accounts/${token.account.id}/health`);
    assert.equal(tokenHealth.apps.find((check) => check.app === app.id)?.check?.status, "healthy");
    const rest = yield* call("fixture.read", token.account.id);
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.deepEqual(rest.body, {
      transport: "rest",
      site: automatic.origin,
    });

    const write = yield* call("fixture.write", token.account.id);
    assert.equal(write.status, 409, "REST writes still need approval");
    assert.equal(write.body._tag, "ToolApprovalRequired");
    const ownBefore = yield* links("gitlab");
    yield* browser.use(
      "The full REST OAuth app guide matches its requested scopes",
      async (page) => {
        const dialog = await openAt(page, automatic.origin);
        await dialog
          .getByRole("button", {
            name: "Use your own GitLab app for the full API",
            exact: true,
          })
          .click();
        await dialog.getByText(`Using ${automatic.origin}`, { exact: true }).waitFor();
        await dialog.getByText("Advanced", { exact: true }).click();
        await dialog
          .getByRole("checkbox", {
            name: "Use your own GitLab app for this account",
            exact: true,
          })
          .check();
        assert.equal(
          await dialog.getByRole("link", { name: "Open GitLab applications", exact: true }).count(),
          0,
          "HTTP fixture setup links stay hidden",
        );
        await dialog
          .getByText("Select both api and read_user and save the application.", { exact: true })
          .waitFor();
        await dialog.getByLabel("Client ID", { exact: true }).fill(restOAuthClient.id);
        await dialog.getByLabel("Client secret", { exact: true }).fill(restOAuthClient.secret);
        await noOverflow(page);
      },
    );
    yield* browser.checkpoint(`GitLab full REST own app ${width}`);
    yield* browser.use("Connect the own REST app and name its account", async (page) => {
      await page
        .getByRole("dialog", { name: dialogName })
        .getByRole("button", { name: "Connect GitLab", exact: true })
        .click();
      await page.getByRole("heading", { name: "GitLab test instance", exact: true }).waitFor();
      await page.getByRole("button", { name: "Authorize", exact: true }).click();
      const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
      await naming.getByLabel("Account name", { exact: true }).fill(`GitLab own app ${width}`);
      await naming.getByRole("button", { name: "Save name", exact: true }).click();
      await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
    });
    const [own] = added(ownBefore, yield* links("gitlab"));
    assert.ok(own, "The own REST OAuth app saves and links an account");
    assert.equal(own.account.method, "oauth");
    assert.equal(own.account.site, automatic.origin);
    const ownHealth = yield* request("POST", `${prefix}/accounts/${own.account.id}/health`);
    assert.equal(ownHealth.apps.find((check) => check.app === app.id)?.check?.status, "healthy");
    const ownRead = yield* call("fixture.read", own.account.id);
    assert.equal(ownRead.status, 200, JSON.stringify(ownRead.body));
    assert.deepEqual(ownRead.body, { transport: "rest", site: automatic.origin });
    const ownWrite = yield* call("fixture.write", own.account.id);
    assert.equal(ownWrite.status, 409, "Own-app REST writes still need approval");
    assert.equal(ownWrite.body._tag, "ToolApprovalRequired");

    const signInBefore = yield* links("signIn");
    yield* browser.use(
      "Switching back keeps the instance, then sign-in registers",
      async (page) => {
        const dialog = await openAt(page, automatic.origin);
        await dialog
          .getByRole("button", {
            name: "Use a personal access token for the full API",
            exact: true,
          })
          .click();
        await dialog
          .getByRole("button", { name: "Sign in with GitLab MCP instead", exact: true })
          .click();
        await dialog.getByText(`Using ${automatic.origin}`, { exact: true }).waitFor();
        await dialog.getByRole("button", { name: "Sign in with GitLab MCP", exact: true }).click();
        await page.getByRole("heading", { name: "GitLab test instance", exact: true }).waitFor();
        await page.getByRole("button", { name: "Authorize", exact: true }).click();
        const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
        await naming.getByLabel("Account name", { exact: true }).fill(`GitLab MCP ${width}`);
        await naming.getByRole("button", { name: "Save name", exact: true }).click();
        await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
      },
    );
    yield* browser.use(
      "Accounts list MCP sign-in and full REST in one GitLab section",
      async (page) => {
        const accounts = page.getByRole("region", { name: "Your accounts", exact: true });
        const gitlab = accounts.getByRole("region", { name: "GitLab", exact: true });
        await gitlab.waitFor();
        // The MCP sign-in's row names the part it serves; a REST account needs no note.
        await gitlab.getByText("For GitLab MCP", { exact: true }).first().waitFor();
        assert.equal(
          await accounts.getByRole("region", { name: "GitLab MCP", exact: true }).count(),
          0,
        );
      },
    );
    yield* browser.checkpoint(`GitLab sign-in complete ${width}`);
    const [signedIn] = added(signInBefore, yield* links("signIn"));
    assert.ok(signedIn, "Approval saves and links one MCP account");
    assert.equal(signedIn.account.method, "mcp");
    assert.equal(signedIn.account.site, automatic.origin);
    const health = yield* request("POST", `${prefix}/accounts/${signedIn.account.id}/health`);
    assert.equal(health.apps.find((check) => check.app === app.id)?.check?.status, "healthy");
    const mcpTool = yield* call("search", signedIn.account.id);
    assert.equal(mcpTool.status, 409, "Every GitLab MCP tool call needs approval");
    assert.equal(mcpTool.body._tag, "ToolApprovalRequired");
    const restFromMcp = yield* call("fixture.read", signedIn.account.id);
    assert.equal(restFromMcp.status, 422, "An mcp-scoped sign-in cannot authorize REST tools");
    const mcpFromToken = yield* call("search", token.account.id);
    assert.equal(mcpFromToken.status, 422, "A REST token cannot authorize MCP tools");

    const cancelBefore = (yield* links("signIn")).map((link) => link.account.id).sort();
    yield* browser.use("Without registration, sign-in explains the own-app setup", async (page) => {
      const dialog = await openAt(page, manual.origin);
      await dialog.getByText(/doesn't offer automatic app registration for sign-in/).waitFor();
      await dialog.getByText("Advanced", { exact: true }).click();
      await dialog
        .getByRole("checkbox", { name: "Use your own GitLab MCP app for this account" })
        .check();
      const link = dialog.getByRole("link", {
        name: "Open GitLab applications",
        exact: true,
      });
      assert.equal(await link.count(), 0, "HTTP fixture setup links stay hidden");
      await dialog.getByText(/clear Confidential and select the mcp scope/).waitFor();
      await dialog.getByText("Use GitLab's Application ID.", { exact: true }).waitFor();
      await dialog.getByText(/Leave Client secret empty/).waitFor();
      await noOverflow(page);
    });
    yield* browser.checkpoint(`GitLab own app for sign-in ${width}`);
    yield* browser.use("Leave own-app setup without saving", async (page) =>
      page.keyboard.press("Escape"),
    );
    assert.deepEqual(
      (yield* links("signIn")).map((link) => link.account.id).sort(),
      cancelBefore,
      "Opening and cancelling own-app setup saves no account or link",
    );
    const blockedBefore = yield* links("signIn");
    yield* browser.use(
      "Disabled MCP keeps its policy limits and REST alternatives visible",
      async (page) => {
        const dialog = await openAt(page, disabled.origin);
        await dialog.getByText(/Your administrator can turn off personal access tokens/).waitFor();
        await dialog
          .getByRole("button", {
            name: "Use a personal access token for the full API",
            exact: true,
          })
          .waitFor();
        await noOverflow(page);
      },
    );
    yield* browser.checkpoint(`GitLab MCP disabled policy ${width}`);
    yield* browser.use(
      "An OAuth grant does not claim a disabled MCP server works",
      async (page) => {
        await page
          .getByRole("dialog", { name: dialogName })
          .getByRole("button", { name: "Sign in with GitLab MCP", exact: true })
          .click();
        await page.getByRole("heading", { name: "GitLab test instance", exact: true }).waitFor();
        await page.getByRole("button", { name: "Authorize", exact: true }).click();
        await nameConnectedAccount(page, `Disabled GitLab MCP ${width}`);
      },
    );
    const [blocked] = added(blockedBefore, yield* links("signIn"));
    assert.ok(blocked, "The disabled instance's grant is kept distinct");
    yield* Effect.gen(function* () {
      const blockedHealth = yield* request(
        "POST",
        `${prefix}/accounts/${blocked.account.id}/health`,
      );
      const blockedCheck = blockedHealth.apps.find((check) => check.app === app.id)?.check;
      assert.equal(blockedCheck?.status, "check_failed", JSON.stringify(blockedCheck));
      assert.equal(blockedCheck?.reason, "rejected");
      assert.match(blockedCheck?.message ?? "", /HTTP 403/);
      const retained = yield* call("fixture.read", token.account.id);
      assert.equal(
        retained.status,
        200,
        `One rejected MCP source must not block a working REST account: ${JSON.stringify(retained.body)}`,
      );
    }).pipe(
      Effect.ensuring(
        request("DELETE", `${prefix}/apps/${app.id}/accounts/user/signIn/${blocked.account.id}`),
      ),
    );
  });
