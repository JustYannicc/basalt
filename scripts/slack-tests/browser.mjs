import { join } from "node:path";
import { writeFile } from "node:fs/promises";

function safeUrl(value) {
  const url = new URL(value);
  return { origin: url.origin, path: url.pathname, queryKeys: [...url.searchParams.keys()] };
}

function within(promise, deadline, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), Math.max(1, deadline - Date.now()));
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Install Slack from the local catalog and follow the provider return through the dashboard. */
export async function connectOwnerFromCatalog({
  target,
  actors,
  ownerCookies,
  mock,
  directory,
  chromium,
  browserExecutable,
  check,
  equal,
  diagnosticOnly = false,
  callbackDiagnostic = false,
}) {
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
  const context = await browser.newContext({
    baseURL: target.metadata.origin,
    viewport: { width: 1440, height: 960 },
  });
  const external = [];
  const events = [];
  const callbackRequests = [];
  const callbackResponses = [];
  const dashboardResponses = [];
  const pageLabels = new WeakMap();
  let installResponsePromise;
  let startRequest;
  let redirectTarget;
  let resolveAuthorizationVisit;
  let resolveCallbackRequest;
  let resolveCallbackResponse;
  let resolveCompletionResponse;
  const authorizationVisit = new Promise((resolve) => { resolveAuthorizationVisit = resolve; });
  const callbackRequestSeen = new Promise((resolve) => { resolveCallbackRequest = resolve; });
  const callbackResponseSeen = new Promise((resolve) => { resolveCallbackResponse = resolve; });
  const completionResponseSeen = new Promise((resolve) => { resolveCompletionResponse = resolve; });

  const labelPage = (page, label) => {
    if (pageLabels.has(page)) return;
    pageLabels.set(page, label);
    page.on("pageerror", (error) => events.push({ type: "pageerror", page: label, message: error.message }));
    page.on("requestfailed", (request) => events.push({
      type: "requestfailed",
      page: label,
      method: request.method(),
      path: new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    }));
    page.on("framenavigated", (frame) => events.push({
      type: "navigation",
      page: label,
      ...safeUrl(frame.url()),
    }));
  };
  const pageLabel = (request) => {
    try { return pageLabels.get(request.frame().page()) ?? "untracked"; } catch { return "untracked"; }
  };

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost"))
      return route.continue();
    external.push(url.hostname);
    return route.abort();
  });
  await context.addCookies(ownerCookies);
  const page = await context.newPage();
  labelPage(page, "owner");
  let popupNumber = 0;
  context.on("page", (popup) => labelPage(popup, `popup-${++popupNumber}`));
  context.on("request", (request) => {
    const url = new URL(request.url());
    const label = pageLabel(request);
    if (request.method() === "POST" && url.pathname.endsWith("/oauth/start")) {
      const match = url.pathname.match(/\/connections\/([^/]+)\/oauth\/start$/);
      if (match) {
        let body;
        try { body = request.postDataJSON(); } catch { body = {}; }
        startRequest = { connectionId: match[1], method: body.method, path: url.pathname, page: label };
      }
    }
    if (url.origin === mock.origin && url.pathname === mock.authorizationPath) {
      const value = url.searchParams.get("redirect_uri");
      if (!value) return;
      const callback = new URL(value);
      redirectTarget = { origin: callback.origin, path: callback.pathname };
      let authorizationPage;
      try { authorizationPage = request.frame().page(); } catch { authorizationPage = undefined; }
      resolveAuthorizationVisit({ authorizationUrl: url.href, page: authorizationPage });
    }
    if (!redirectTarget || url.origin !== redirectTarget.origin || url.pathname !== redirectTarget.path) return;
    const record = {
      source: "browser-request",
      page: label,
      method: request.method(),
      ...safeUrl(url.href),
      hasCode: url.searchParams.has("code"),
      hasState: url.searchParams.has("state"),
    };
    callbackRequests.push(record);
    if (record.hasCode && record.hasState) resolveCallbackRequest(record);
  });
  context.on("response", (response) => {
    const url = new URL(response.url());
    const request = response.request();
    const isLocal = url.origin === target.metadata.origin || url.origin === mock.origin
      || url.hostname.endsWith(".localhost");
    if (!isLocal) return;
    const record = {
      type: "response",
      page: pageLabel(request),
      method: request.method(),
      ...safeUrl(url.href),
      status: response.status(),
    };
    events.push(record);
    if (request.method() === "POST" && url.pathname.endsWith("/apps/install"))
      installResponsePromise = response.text().then((body) => ({ method: request.method(), path: url.pathname, status: response.status(), body }));
    if (redirectTarget && request.method() === "GET"
      && url.origin === redirectTarget.origin && url.pathname === redirectTarget.path) {
      const location = response.headers().location;
      const callback = {
        ...record,
        location: location ? safeUrl(new URL(location, url.origin).href) : undefined,
      };
      callbackResponses.push(callback);
      resolveCallbackResponse(callback);
    }
    if (url.pathname === "/oauth/callback") dashboardResponses.push(record);
    if (request.method() === "POST" && url.pathname.endsWith("/oauth/complete")) {
      response.json().then((body) => resolveCompletionResponse({
        status: response.status(),
        origin: url.origin,
        path: url.pathname,
        accountId: typeof body?.id === "string" ? body.id : undefined,
      }), () => resolveCompletionResponse({ status: response.status(), origin: url.origin, path: url.pathname }));
    }
  });

  try {
    await page.goto(`${target.metadata.origin}/org/${actors.organization.slug}/setup/accounts`);
    const row = page.getByRole("group", { name: "Slack", exact: true });
    await row.waitFor();
    await row.getByRole("button", { name: "Connect", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Connect Slack", exact: true });
    const failedDialog = page.getByRole("dialog", { name: "Couldn’t connect Slack", exact: true });
    try {
      const result = await Promise.race([
        dialog.waitFor({ state: "visible", timeout: 60_000 }).then(() => "ready"),
        failedDialog.waitFor({ state: "visible", timeout: 60_000 }).then(() => "failed"),
      ]);
      if (result === "failed") throw new Error("Slack app installation failed before its OAuth dialog opened.");
    } catch (error) {
      await page.screenshot({ path: join(directory, "slack-connect-failure.png") }).catch(() => undefined);
      const installResponse = await installResponsePromise?.catch(() => undefined);
      await writeFile(join(directory, "slack-connect-failure.json"), JSON.stringify({
        page: safeUrl(page.url()), events, startRequest, installResponse,
      }, null, 2), { mode: 0o600 }).catch(() => undefined);
      if (diagnosticOnly && installResponse?.status >= 400)
        return { installed: false, installResponse };
      throw error;
    }
    await dialog.getByRole("button", { name: "Connect Slack", exact: true }).waitFor({ state: "visible" });
    equal(await dialog.getByRole("note", { name: "Slack connection notices" }).count(), 0,
      "The Slack connect dialog must not show a notice");
    await page.screenshot({ path: join(directory, "slack-connect.png") });
    equal(await dialog.getByRole("textbox", { name: "Client ID", exact: true }).count(), 0,
      "The one-click Slack flow must not ask for a client ID");
    if (diagnosticOnly) return { installed: true, external };

    const connect = dialog.getByRole("button", { name: "Connect Slack", exact: true });
    await connect.waitFor({ state: "visible" });
    await connect.click();
    const authorization = await within(authorizationVisit, Date.now() + 20_000,
      "The browser did not request the Slack authorization URL");
    const authorizationUrl = new URL(authorization.authorizationUrl);
    check(redirectTarget, "The Slack authorization request omitted redirect_uri");
    equal(redirectTarget.path, "/api/oauth/callback", "The registered callback path changed");
    const authorizationPage = authorization.page ?? page;
    await authorizationPage.waitForURL((url) => url.origin === mock.origin && url.pathname === mock.authorizationPath, {
      timeout: 20_000,
    });
    await authorizationPage.getByRole("button", { name: "Connect as Synthetic Owner", exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    equal(authorizationUrl.searchParams.get("scope") ?? "", "", "The one-click UI requested bot scope");
    const authorized = new URL(authorizationPage.url());
    await authorizationPage.getByRole("button", { name: "Connect as Synthetic Owner", exact: true })
      .click({ noWaitAfter: true });

    const deadline = Date.now() + 20_000;
    let callbackRequest;
    let callbackResponse;
    let completionResponse;
    let connectedText;
    try {
      [callbackRequest, callbackResponse, completionResponse] = await Promise.all([
        within(callbackRequestSeen, deadline, "The browser did not request the registered OAuth callback"),
        within(callbackResponseSeen, deadline, "The OAuth callback did not return a response"),
        within(completionResponseSeen, deadline, "The dashboard did not complete the OAuth connection"),
      ]);
      await authorizationPage.getByRole("dialog", { name: "Name this account", exact: true })
        .waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
      const connectedDialog = authorizationPage.getByRole("dialog", { name: "Name this account", exact: true });
      await connectedDialog.getByText(/is connected\./).waitFor({
        state: "visible", timeout: Math.max(1, deadline - Date.now()),
      });
      connectedText = await connectedDialog.innerText();
      check(connectedText.includes("is connected."), "The dashboard did not show the connected Slack account");
      check(callbackRequest.hasCode && callbackRequest.hasState, "The callback omitted its authorization code or state");
      equal(callbackResponse.status, 302, "The callback did not redirect to the dashboard");
      equal(callbackResponse.location?.path, "/oauth/callback", "The callback redirected to the wrong dashboard path");
      equal(completionResponse.status, 200, "The dashboard OAuth completion did not succeed");
      check(typeof completionResponse.accountId === "string", "The dashboard completion did not return an account ID");
      check(external.length === 0, `The local browser attempted an outside request: ${external.join(",")}`);
    } catch (error) {
      await authorizationPage.screenshot({ path: join(directory, "slack-oauth-callback-failure.png") }).catch(() => undefined);
      await writeFile(join(directory, "slack-oauth-callback-failure.json"), JSON.stringify({
        authorizationRedirect: redirectTarget,
        page: safeUrl(authorizationPage.url()),
        callbackRequests,
        callbackResponses,
        dashboardResponses,
        completionResponse,
        events,
        startRequest,
        mock: mock.observations(),
      }, null, 2), { mode: 0o600 }).catch(() => undefined);
      throw error;
    }
    check(startRequest, "The connect row did not start hosted OAuth");
    equal(startRequest.method, "user", "The connect row did not choose the first Slack user OAuth method");
    equal(authorized.origin, mock.origin, "The browser did not visit the Slack mock");
    equal(authorized.pathname, mock.authorizationPath, "The browser used the wrong Slack OAuth path");
    const result = {
      connectionId: startRequest?.connectionId,
      accountId: completionResponse.accountId,
      redirectTarget,
      callbackRequest,
      callbackResponse,
      dashboardResponse: dashboardResponses.at(-1),
      completionResponse,
      connectedText,
      authorizationPath: authorized.pathname,
      external,
    };
    if (callbackDiagnostic) {
      await authorizationPage.screenshot({ path: join(directory, "slack-oauth-callback-completed.png") });
      await writeFile(join(directory, "slack-oauth-callback-result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
      return { ...result, callbackDiagnostic: true };
    }
    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}
