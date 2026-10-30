import assert from "node:assert/strict";
import { join } from "node:path";
import { appsManifest } from "../../.upstream/e2e/support/apps-release.ts";

/** Drive a site form through origin capture, a real metadata failure, and public BYO. */
export function proveAccountSiteUi({
  Effect, request, checked, actors, browser, cookies, directory, target, sites,
  appName = "Account site UI fixture", defaultOrigin = false, screenshotPrefix = "account-site",
}) {
  return Effect.gen(function* () {
    const template = sites[0];
    const selected = sites[1];
    const source = `import { defineApp, defineProvider, oauth2, object, query, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(appName)}, hosts: [${JSON.stringify(template.host)}],
  site: { label: "Account site", origin: ${JSON.stringify(template.origin)},
    ${defaultOrigin ? "defaultOrigin: true" : 'subdomainOf: "localhost"'} },
  auth: { oauth: oauth2({ authorizationUrl: ${JSON.stringify(`${template.origin}/ui/oauth/authorize`)},
    tokenUrl: ${JSON.stringify(`${template.origin}/ui/oauth/token`)},
    authorizationServerMetadataUrl: ${JSON.stringify(`${template.origin}/ui/metadata-unavailable`)}, scopes: ["read"] }) } });
export default defineApp({ user: { accounts: { service } } }, { tools: router({
  site: query({ input: object({}) }, async ({ user: { accounts } }) => accounts.service.site)
}) });`;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const app = checked(yield* request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: appName, files: [{ path: "index.ts", content: source }, appsManifest],
    }), 200, "Deploy site-form UI fixture");
    const path = `${prefix}/apps/${app.id}`;
    const access = checked(yield* request(actors.owner, "GET", `${path}/access`), 200, "Read UI app access");
    checked(yield* request(actors.owner, "PATCH", `${path}/access`, {
      revision: access.revision, audience: { kind: "everyone" },
    }), 200, "Share UI app with member");
    const context = yield* Effect.acquireRelease(Effect.promise(() => browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split(".")[0]}.0.0.0 Safari/537.36`,
    })), (context) => Effect.promise(() => context.close()));
    return yield* Effect.promise(async () => {
      await context.addCookies(cookies);
      await context.route("**/*", (route) => {
        const host = new URL(route.request().url()).hostname;
        return host === "127.0.0.1" || host === "localhost" || host.endsWith(".localhost")
          ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      const errors = [];
      const preflight = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (/\/oauth\/[^/]+\/setup(?:\?|$)/.test(new URL(request.url()).pathname)) preflight.push(request.url());
      });
      await page.goto(`${target.metadata.origin}/org/${actors.organization.slug}/apps/${app.id}?view=accounts`);
      await page.getByRole("button", { name: "Connect new account", exact: true }).click();
      const site = page.getByLabel("Account site", { exact: true });
      if (defaultOrigin) {
        await page.getByText(`Using ${template.origin}`, { exact: true }).waitFor({ state: "visible" });
        const useAnother = page.getByRole("button", { name: "Use another instance", exact: true });
        await useAnother.waitFor({ state: "visible" });
        await page.screenshot({ path: join(directory, `${screenshotPrefix}-default.png`), animations: "disabled" });
        await useAnother.click();
        await site.waitFor({ state: "visible" });
        await page.screenshot({ path: join(directory, `${screenshotPrefix}-change-origin.png`), animations: "disabled" });
      } else {
        await site.waitFor({ state: "visible" });
        assert.equal(preflight.length, 0, "No OAuth setup request may run before the site exists");
      }
      assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled(), true);
      await site.fill(selected.origin);
      await page.screenshot({ path: join(directory, `${screenshotPrefix}-entry.png`), animations: "disabled" });
      const created = page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === `${path}/accounts/user/service/connections`);
      const setup = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/oauth/oauth/setup"));
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const connection = await created;
      assert.equal(connection.status(), 200);
      assert.equal(connection.request().postDataJSON().site, selected.origin, "The form must freeze the selected site at creation");
      const failedSetup = await setup;
      assert.ok(failedSetup.status() >= 400, "The unavailable metadata must produce a real setup failure");
      const clientId = page.getByLabel("Client ID", { exact: true });
      await clientId.waitFor({ state: "visible" });
      assert.equal(await clientId.isEnabled(), true, "A setup failure must leave manual BYO usable");
      await clientId.fill("synthetic-public-client");
      const connect = page.getByRole("button", { name: `Connect ${appName}`, exact: true });
      assert.equal(await connect.isEnabled(), true, "Public BYO must not require a secret");
      const access = page.locator("[data-credential-hosts]");
      assert.ok((await access.innerText()).includes(selected.host), "Safety text must name the selected site");
      assert.equal((await access.innerText()).includes(template.host), false, "Safety text must not name the template host");
      await page.screenshot({ path: join(directory, `${screenshotPrefix}-byo-after-setup-failure.png`), animations: "disabled" });
      const start = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/oauth/start"));
      await connect.click();
      const started = await start;
      assert.equal(started.status(), 200, "Entered BYO must bypass failed optional discovery");
      const authorization = new URL((await started.json()).authorizationUrl);
      assert.equal(authorization.origin, selected.origin);
      assert.equal(authorization.pathname, "/ui/oauth/authorize");
      assert.equal(authorization.searchParams.get("client_id"), "synthetic-public-client");
      assert.deepEqual(errors, [], "The site and BYO form must not throw browser errors");
      return {
        ...(defaultOrigin ? { defaultOriginSwitch: true } : { hostedSiteBeforePreflight: true }),
        hostedByoAfterSetupFailure: true,
        hostedPublicByoStart: true,
      };
    });
  });
}
