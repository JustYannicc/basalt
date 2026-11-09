import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { Browser } from "../../.upstream/e2e/support/browser.ts";
import { hostedScopes, sorted, legacyNames, api, limited, tokenOnly } from "./expectations.mjs";
import { registrationDefault, serviceToken } from "./service.mjs";
import { verifyExceededGrant } from "./grant-envelope.mjs";
import { verifyRefusedGrant } from "./grant-refusal.mjs";
const dialogName = /^Connect PlanetScale(?: · .+)?$/;
const noOverflow = async (page) =>
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "No horizontal overflow",
  );
// PlanetScale's two requirements share one section, whose connect menu lists each method.
const openConnect = async (page) => {
  await page
    .getByRole("region", { name: "Your accounts", exact: true })
    .getByRole("region", { name: "PlanetScale", exact: true })
    .getByRole("button", { name: "Connect new account", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Sign in with PlanetScale", exact: true }).click();
  return page.getByRole("dialog", { name: dialogName });
};

export const verifyPlanetScaleConnections = ({
  width,
  directory,
  mode,
  session,
  actors,
  app,
  links,
  request,
  path,
  prefix,
  omitsGrantedScope,
  refusedScope,
  added,
  listed,
  call,
  apiCalls,
  client,
  getTool,
  service,
  supportedScopes,
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const setupBefore = yield* links();
    yield* browser.login(session);
    yield* browser.use(`Open PlanetScale at ${width}`, async (page) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
      await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
    });
    if (mode === "exceeded") {
      yield* verifyExceededGrant({
        browser,
        request,
        path,
        prefix,
        added,
        links,
        before: setupBefore,
      });
      return;
    }
    if (mode === "refused" || mode === "unreported") {
      yield* verifyRefusedGrant({
        browser,
        directory,
        width,
        request,
        path,
        prefix,
        omitsGrantedScope,
        refusedScope,
        noOverflow,
        added,
        before: setupBefore,
        links,
      });
      return;
    }
    yield* browser.use("One connect starts with PlanetScale sign-in", async (page) => {
      const dialog = await openConnect(page);
      await dialog.getByRole("button", { name: "Sign in with PlanetScale", exact: true }).waitFor();
      await dialog
        .getByText("Connect your PlanetScale account to use its API tools.", {
          exact: true,
        })
        .waitFor();
      await dialog.getByText("What does sign-in connect?", { exact: true }).click();
      await dialog.getByText(/Keyspaces, safe migrations, cluster settings/).waitFor();
      await noOverflow(page);
    });
    yield* browser.checkpoint(`PlanetScale sign-in ${mode} ${width}`);
    yield* browser.use("A service token is one click away with exact steps", async (page) => {
      const dialog = page.getByRole("dialog", { name: dialogName });
      await dialog
        .getByRole("button", { name: "Use a service token instead", exact: true })
        .click();
      const link = dialog.getByRole("link", {
        name: "Open PlanetScale's service token guide",
        exact: true,
      });
      assert.equal(
        await link.getAttribute("href"),
        "https://planetscale.com/docs/api/reference/service-tokens",
      );
      assert.equal(await dialog.getByLabel("Service token", { exact: true }).count(), 1);
      await dialog
        .getByText("Paste SERVICE_TOKEN_ID:SERVICE_TOKEN as one value, without Bearer.", {
          exact: true,
        })
        .waitFor();
      await noOverflow(page);
      await dialog.getByRole("button", { name: "Sign in with PlanetScale", exact: true }).click();
    });
    yield* browser.checkpoint(`PlanetScale service token guidance ${mode} ${width}`);
    yield* browser.use("Own OAuth app guidance names the Client ID", async (page) => {
      const dialog = page.getByRole("dialog", { name: dialogName });
      await dialog.getByText("Advanced", { exact: true }).click();
      await dialog.getByRole("combobox", { name: "OAuth client", exact: true }).click();
      await page
        .getByRole("option", { name: "Your own PlanetScale app (OAuth)", exact: true })
        .click();
      const link = dialog.getByRole("link", {
        name: "Open PlanetScale's OAuth app guide",
        exact: true,
      });
      assert.equal(
        await link.getAttribute("href"),
        "https://planetscale.com/docs/api/reference/oauth",
      );
      await dialog
        .getByText("Use the Client ID, not the application's ID.", { exact: true })
        .waitFor();
      await noOverflow(page);
      await page.keyboard.press("Escape");
    });
    yield* browser.checkpoint(`PlanetScale own app guidance ${mode} ${width}`);

    const before = yield* links();
    assert.deepEqual(
      before.map((row) => row.account.id).sort(),
      setupBefore.map((row) => row.account.id).sort(),
      "Cancelling own-app setup saves no account",
    );
    yield* browser.use("Sign in once and approve at PlanetScale", async (page) => {
      const dialog = await openConnect(page);
      await dialog.getByRole("button", { name: "Sign in with PlanetScale", exact: true }).click();
      await page
        .getByRole("heading", { name: "PlanetScale test authorization", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Authorize", exact: true }).click();
      const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
      await naming
        .or(page.getByRole("heading", { name: "Account not connected", exact: true }))
        .waitFor();
      assert.equal(await naming.count(), 1, "Every supported PlanetScale scope must be kept");
      await naming.getByLabel("Account name", { exact: true }).fill(`PlanetScale ${mode} ${width}`);
      await naming.getByRole("button", { name: "Save name", exact: true }).click();
      await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
    });
    const [signedIn] = added(before, yield* links());
    assert.ok(signedIn, "Sign-in saves and links one account");
    assert.equal(signedIn.account.method, "signIn");
    const health = yield* request("POST", `${prefix}/accounts/${signedIn.account.id}/health`);
    assert.equal(health.apps.find((check) => check.app === app.id)?.check?.status, "healthy");

    // The permissions tool belongs to the app, not to one account.
    const permissions = yield* client.request(session, "POST", `${path}/tools/call`, {
      tool: "permissions",
      input: {},
    });
    assert.equal(permissions.status, 200, JSON.stringify(permissions.body));
    const own = permissions.body.find((row) => row.accountId === signedIn.account.id);
    yield* Effect.promise(() =>
      writeFile(
        join(directory, `access-${width}.json`),
        JSON.stringify({ permissions: own }, null, 2),
        { mode: 0o600 },
      ),
    );
    if (omitsGrantedScope) {
      assert.equal(
        own.permissions,
        "Unknown: PlanetScale did not report this account's permissions.",
      );
      assert.equal(own.unavailableTools, null);
    } else {
      const granted =
        mode === "expanded"
          ? supportedScopes
          : mode === "hosted"
            ? hostedScopes
            : registrationDefault;
      for (const scope of granted)
        assert.ok(own.permissions.includes(scope), `${scope} is reported`);
      assert.ok(own.unavailableTools.includes("serviceToken.serviceTokens.listServiceTokens"));
    }

    // Tools follow the reported grant: nothing PlanetScale did not grant is listed or reachable.
    const oauthTools = yield* listed();
    const expectedOauthTools = omitsGrantedScope
      ? legacyNames
      : ["hosted", "expanded"].includes(mode)
        ? api
        : limited;
    assert.deepEqual(oauthTools, sorted([...expectedOauthTools, "permissions"]));
    const read = yield* call("databases.listDatabases", signedIn.account.id, {
      path: { organization: "acme" },
    });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body, { operation: "list_databases", credential: "oauth" });
    const write = yield* call("databaseBranches.demoteBranch", signedIn.account.id, {
      path: { organization: "acme", database: "app", branch: "main" },
    });
    if (mode !== "dcr") {
      assert.equal(write.status, 409, "Every PlanetScale change needs approval");
      assert.equal(write.body._tag, "ToolApprovalRequired");
    } else assert.ok(write.status >= 400 && write.status < 500, "An ungranted write is refused");
    assert.equal(apiCalls("demote_branch").length, 0, "No write reached PlanetScale");
    const forToken = yield* call(
      "serviceToken.serviceTokens.listServiceTokens",
      signedIn.account.id,
      {
        path: { organization: "acme" },
      },
    );
    assert.ok(
      forToken.status >= 400 && forToken.status < 500,
      "OAuth never reaches token-only tools",
    );
    yield* browser.use("Tools show the missing service-token section", async (page) => {
      await page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=tools`);
      const section = page.getByRole("region", {
        name: "PlanetScale service-token tools",
        exact: true,
      });
      await section.waitFor();
      await section.getByText(/aren't available through sign-in/).waitFor();
      await noOverflow(page);
    });
    yield* browser.checkpoint(`PlanetScale tools after sign-in ${mode} ${width}`);
    const tokensBefore = yield* links();
    yield* browser.use("Add service token opens the token form in one click", async (page) => {
      await page.getByRole("button", { name: "Add service token", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: dialogName });
      await dialog.getByLabel("Service token", { exact: true }).fill(serviceToken);
      await dialog.locator('button[type="submit"]').click();
      await dialog.getByText(/Signed in as acme/).waitFor();
      // Naming starts a background identity check. Its API call must finish before the
      // legacy-resolution baseline, otherwise that unrelated call can land inside the loop.
      const namingCheck = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/api\/organizations\/[^/]+\/accounts\/[^/]+\/health$/u.test(response.url()),
      );
      await dialog.getByRole("button", { name: "Continue", exact: true }).click();
      const naming = page.getByRole("dialog", { name: "Name this account", exact: true });
      await naming
        .or(page.getByRole("heading", { name: "Account not connected", exact: true }))
        .waitFor();
      assert.equal(await naming.count(), 1, "Every supported PlanetScale scope must be kept");
      await naming.getByLabel("Account name", { exact: true }).fill(`PlanetScale token ${width}`);
      const checked = await namingCheck;
      assert.equal(checked.status(), 200, "The token naming health check completes");
      await checked.finished();
      await naming.getByRole("button", { name: "Save name", exact: true }).click();
      await page
        .getByRole("region", { name: "PlanetScale service-token tools", exact: true })
        .waitFor({ state: "hidden" });
    });
    yield* browser.checkpoint(`PlanetScale with a service token ${mode} ${width}`);
    const [token] = added(tokensBefore, yield* links());
    assert.ok(token, "The token saves and links one account");
    assert.equal(token.account.method, "token");
    assert.deepEqual(yield* listed(), sorted([...legacyNames, ...tokenOnly, "permissions"]));
    assert.equal(legacyNames.length, 291);
    if (mode === "hosted" && width === 1280) {
      const apiCallsBeforeResolution = service.calls.filter(
        (entry) => entry.phase === "api",
      ).length;
      for (const name of legacyNames) {
        const resolved = yield* getTool(name);
        assert.equal(
          resolved.status,
          200,
          `${name} did not resolve: ${JSON.stringify(resolved.body)}`,
        );
        assert.equal(resolved.body.name, name, `${name} resolved under a different name`);
      }
      assert.equal(
        service.calls.filter((entry) => entry.phase === "api").length,
        apiCallsBeforeResolution,
        "Resolving every legacy tool name does not execute a PlanetScale operation",
      );
    }
    const tokenRead = yield* call(
      "serviceToken.serviceTokens.listServiceTokens",
      token.account.id,
      {
        path: { organization: "acme" },
      },
    );
    assert.equal(tokenRead.status, 200, JSON.stringify(tokenRead.body));
    assert.deepEqual(tokenRead.body, { operation: "list_service_tokens", credential: "token" });

    // Unlinking the token restores the prompt; the signed-in account and its tools remain.
    yield* request("DELETE", `${path}/accounts/user/planetscale/${token.account.id}`);
    yield* request("DELETE", `${prefix}/accounts/${token.account.id}`);
    assert.deepEqual(yield* listed(), oauthTools);
    yield* browser.use("Unlink restores the service-token prompt", async (page) => {
      await page.reload();
      await page.getByRole("button", { name: "Add service token", exact: true }).waitFor();
    });
    yield* request("DELETE", `${path}/accounts/user/planetscaleSignIn/${signedIn.account.id}`);
    yield* request("DELETE", `${prefix}/accounts/${signedIn.account.id}`);
  });
