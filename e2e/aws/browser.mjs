import { chmod } from "node:fs/promises";
import { join } from "node:path";

/** Exercise the hosted paste form through the app's public Accounts view. */
export async function proveAwsPasteUi({
  browser,
  target,
  actors,
  ownerCookies,
  app,
  fixture,
  directory,
  check,
  equal,
}) {
  const context = await browser.newContext({
    baseURL: target.metadata.origin,
    viewport: { width: 1440, height: 960 },
  });
  const screenshotNames = [];
  let outsideRequests = 0;
  let callbackWaiter;
  const callbackBase = fixture.expectedCallback;
  const callbackOrigin = "http://127.0.0.1:43119";
  const accountName = "AWS browser account";
  const appPath = `/org/${actors.organization.slug}/apps/${app.id}`;

  const nextCallback = () =>
    new Promise((resolve) => {
      callbackWaiter = resolve;
    });
  const capture = async (name, page) => {
    const path = join(directory, name);
    await page.screenshot({ path, animations: "disabled" });
    await chmod(path, 0o600);
    screenshotNames.push(name);
  };
  const startPasteFlow = async (dialog, buttonName, page) => {
    const callbackPromise = nextCallback();
    const popupPromise = context.waitForEvent("page");
    const startedPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/oauth/start"),
    );
    await dialog.getByRole("button", { name: buttonName, exact: true }).click();
    const [started, popup, returned] = await Promise.all([
      startedPromise,
      popupPromise,
      callbackPromise,
    ]);
    check(started.status() === 200, `${buttonName} did not start the hosted OAuth flow`);
    const response = await started.json();
    equal(
      response.redirectUri,
      fixture.expectedCallback,
      "The hosted form must use AWS's provider-owned loopback callback",
    );
    check(
      typeof response.authorizationUrl === "string" &&
        response.authorizationUrl.startsWith(`${fixture.origin}/authorize?`),
      "The hosted form did not open the controlled AWS authorization fixture",
    );
    check(
      returned.summary.hasCode && returned.summary.hasState,
      "The provider callback must carry its code and state",
    );
    const address = dialog.getByRole("textbox", {
      name: "Address of the page you landed on",
      exact: true,
    });
    await address.waitFor({ state: "visible" });
    return { address, popup, callbackUrl: returned.url, callback: returned.summary };
  };

  try {
    await context.addCookies(ownerCookies);
    await context.route("**/*", async (route) => {
      const requested = route.request().url();
      if (requested === callbackBase || requested.startsWith(`${callbackBase}?`)) {
        const queryStart = requested.indexOf("?");
        const query = new URLSearchParams(queryStart < 0 ? "" : requested.slice(queryStart + 1));
        const resolve = callbackWaiter;
        callbackWaiter = undefined;
        resolve?.({
          url: requested,
          summary: {
            origin: callbackOrigin,
            path: "/oauth/callback",
            hasCode: query.has("code"),
            hasState: query.has("state"),
          },
        });
        return route.abort("connectionrefused");
      }
      if (requested === callbackOrigin || requested.startsWith(`${callbackOrigin}/`))
        return route.abort("connectionrefused");
      if (
        requested === target.metadata.origin ||
        requested.startsWith(`${target.metadata.origin}/`) ||
        requested === fixture.origin ||
        requested.startsWith(`${fixture.origin}/`)
      )
        return route.continue();
      outsideRequests++;
      return route.abort();
    });

    const page = await context.newPage();
    await page.goto(`${target.metadata.origin}${appPath}?view=accounts`);
    const yourAccounts = page.getByRole("region", { name: "Your accounts", exact: true });
    await yourAccounts.waitFor({ state: "visible" });
    await yourAccounts
      .getByRole("region", { name: "AWS", exact: true })
      .getByRole("button", { name: "Connect new account", exact: true })
      .click();
    const connectDialog = page.getByRole("dialog", { name: "Connect AWS", exact: true });
    // AWS's sign-in and Identity Center share one section, whose connect menu lists both.
    await page.getByRole("menuitem", { name: "Sign in with AWS", exact: true }).click();
    await connectDialog.waitFor({ state: "visible" });

    const first = await startPasteFlow(connectDialog, "Connect AWS", page);
    equal(await first.address.inputValue(), "", "The paste field must be empty before submission");
    await capture("aws-paste-step.png", page);
    await connectDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await first.address.waitFor({ state: "detached" });
    await connectDialog
      .getByRole("button", { name: "Connect AWS", exact: true })
      .waitFor({ state: "visible" });
    await capture("aws-paste-cancel-return.png", page);
    await first.popup.close();
    first.callbackUrl = "";

    let completionRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/oauth/complete"))
        completionRequests++;
    });
    const second = await startPasteFlow(connectDialog, "Connect AWS", page);
    equal(
      await second.address.inputValue(),
      "",
      "Restarting sign-in must return an empty paste field",
    );
    await second.address.fill(`${callbackOrigin}/not-a-callback`);
    await connectDialog.getByRole("button", { name: "Connect account", exact: true }).click();
    const invalidMessage = connectDialog.getByText(
      "Paste the full address. It starts with http://127.0.0.1:43119/oauth/callback.",
      { exact: true },
    );
    await invalidMessage.waitFor({ state: "visible" });
    equal(completionRequests, 0, "An invalid paste must not call the hosted completion API");
    await capture("aws-paste-invalid-recoverable.png", page);

    await second.address.fill(second.callbackUrl);
    second.callbackUrl = "";
    const completedPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/oauth/complete"),
    );
    await connectDialog.getByRole("button", { name: "Connect account", exact: true }).click();
    const completedResponse = await completedPromise;
    equal(
      completedResponse.status(),
      200,
      "The pasted provider callback must complete successfully",
    );
    const saved = await completedResponse.json();
    check(typeof saved.id === "string", "The pasted callback did not save an AWS account");
    await connectDialog.waitFor({ state: "hidden" });

    const nameDialog = page.getByRole("dialog", { name: "Name this account", exact: true });
    await nameDialog.waitFor({ state: "visible" });
    const nameField = nameDialog.getByRole("textbox", { name: "Account name", exact: true });
    await nameField.fill(accountName);
    await nameDialog.getByRole("button", { name: "Save name", exact: true }).click();
    await nameDialog.waitFor({ state: "hidden" });
    const manageAccount = yourAccounts.getByRole("button", {
      name: `Manage ${accountName} in Your accounts`,
      exact: true,
    });
    await manageAccount.waitFor({ state: "visible" });
    await capture("aws-paste-completed.png", page);

    await manageAccount.click();
    await page.getByRole("menuitem", { name: "Reconnect", exact: true }).click();
    const reconnectDialog = page.getByRole("dialog", { name: "Reconnect AWS", exact: true });
    await reconnectDialog.waitFor({ state: "visible" });
    const reconnect = await startPasteFlow(reconnectDialog, "Reconnect AWS", page);
    equal(await reconnect.address.inputValue(), "", "Reconnect must open a clean paste field");
    await capture("aws-reconnect-paste-step.png", page);
    let reconnectCallbackUrl = reconnect.callbackUrl;
    await reconnect.address.fill(reconnectCallbackUrl);
    reconnectCallbackUrl = "";
    const reconnectedPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/oauth/complete"),
    );
    await reconnectDialog.getByRole("button", { name: "Connect account", exact: true }).click();
    const reconnectedResponse = await reconnectedPromise;
    equal(reconnectedResponse.status(), 200, "The reconnect callback must complete successfully");
    const reconnected = await reconnectedResponse.json();
    equal(reconnected.id, saved.id, "Hosted reconnect must preserve the existing AWS account ID");
    await reconnectDialog.waitFor({ state: "hidden" });
    equal(
      await page.getByRole("dialog", { name: "Name this account", exact: true }).count(),
      0,
      "Reconnect must not reopen account naming",
    );
    await manageAccount.waitFor({ state: "visible" });
    await capture("aws-reconnect-preserved-name.png", page);
    equal(outsideRequests, 0, "The hosted paste flow must not make outside network requests");

    return {
      cancelReturnsToForm: true,
      invalidPasteRejectedWithoutCompletion: true,
      validCallbackPastedThroughHostedForm: true,
      newAccountSaved: true,
      reconnectPreservedAccountId: true,
      reconnectPreservedName: true,
      callback: second.callback,
      outsideRequests,
      screenshots: screenshotNames,
    };
  } finally {
    await context.close();
  }
}
