import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

/** One integrated hosted connection, with the provider's consent emulated on its HTTPS fixture. */
export function proveZohoMcpUi({
  Effect,
  target,
  actors,
  app,
  fixture,
  directory,
  prefix,
  request,
  check,
}) {
  return Effect.gen(function* () {
    const { chromium } = createRequire(join(import.meta.dirname, "../.upstream/package.json"))(
      "playwright",
    );
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ headless: true })),
      (value) => Effect.promise(() => value.close()),
    );
    const context = yield* Effect.acquireRelease(
      Effect.promise(() =>
        browser.newContext({
          viewport: { width: 1280, height: 900 },
          userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split(".")[0]}.0.0.0 Safari/537.36`,
        }),
      ),
      (value) => Effect.promise(() => value.close()),
    );
    return yield* Effect.promise(async () => {
      await context.addCookies(actors.owner.cookies);
      const consent = Promise.withResolvers();
      const events = [];
      context.on("response", (response) =>
        events.push({
          kind: "response",
          path: new URL(response.url()).pathname,
          status: response.status(),
        }),
      );
      context.on("requestfailed", (request) =>
        events.push({
          kind: "failed",
          path: new URL(request.url()).pathname,
          reason: request.failure()?.errorText,
        }),
      );
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === fixture.origin && url.pathname === "/authorize") {
          const callback = await fixture.approve(url.href);
          const redirect = new URL(url.searchParams.get("redirect_uri"));
          const loopback =
            redirect.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
          consent.resolve({ callback, loopback });
          return loopback
            ? route.fulfill({
                status: 200,
                contentType: "text/plain",
                body: "Synthetic consent granted. Return to the app with the callback URL.",
              })
            : route.fulfill({ status: 302, headers: { location: callback }, body: "" });
        }
        return url.hostname === "127.0.0.1" ||
          url.hostname === "localhost" ||
          url.hostname.endsWith(".localhost")
          ? route.continue()
          : route.abort();
      });
      const page = await context.newPage();
      const errors = [];
      const setup = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/oauth/mcp/setup")) setup.push(true);
      });
      const appUrl = `${target.metadata.origin}/org/${actors.organization.slug}/apps/${app.id}?view=accounts`;
      try {
        await page.goto(appUrl);
        await page.getByRole("button", { name: "Connect new account", exact: true }).click();
        const method = page.getByRole("combobox", { name: "Sign-in method" });
        await method.waitFor({ state: "visible" });
        assert.ok((await method.innerText()).includes("EU"), "REST stays the default sign-in");
        await page.screenshot({
          path: join(directory, "zoho-rest-default-1280.png"),
          animations: "disabled",
        });
        await method.click();
        await page.getByRole("option", { name: /Sign in with Zoho People \(MCP\)/ }).click();
        const input = page.getByLabel("MCP server URL", { exact: true });
        await input.waitFor({ state: "visible" });
        assert.equal(await input.getAttribute("type"), "password");
        assert.equal(setup.length, 0, "OAuth discovery waits for the private endpoint");
        await page
          .getByRole("link", { name: "Read Zoho MCP setup instructions", exact: true })
          .waitFor();
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.screenshot({
            path: join(directory, `zoho-mcp-entry-${width}.png`),
            animations: "disabled",
          });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            "Endpoint form has no horizontal overflow",
          );
        }
        const proceed = page.getByRole("button", { name: "Continue", exact: true });
        assert.equal(await proceed.isDisabled(), true);
        await input.fill("http://unlisted.invalid/mcp");
        await input.blur();
        await page
          .getByText("Enter a full URL that starts with https://.", { exact: true })
          .waitFor();
        assert.equal(await proceed.isDisabled(), true);
        await input.fill(fixture.endpoint);
        await page.getByRole("button", { name: "Show MCP server URL", exact: true }).click();
        assert.equal(await input.getAttribute("type"), "text");
        await page.getByRole("button", { name: "Hide MCP server URL", exact: true }).click();
        const saved = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith("/mcp-endpoint"),
        );
        await proceed.click();
        assert.equal((await saved).status(), 200);
        await page.locator('[data-mcp-endpoint="configured"]').waitFor();
        assert.equal(await input.count(), 0, "The private URL is cleared after saving");
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page
            .getByRole("button", { name: "Sign in with Zoho People", exact: true })
            .waitFor();
          await page.screenshot({
            path: join(directory, `zoho-mcp-ready-${width}.png`),
            animations: "disabled",
          });
        }
        const completed = context.waitForEvent("response", {
          predicate: (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith("/oauth/complete"),
        });
        await page.getByRole("button", { name: "Sign in with Zoho People", exact: true }).click();
        const { callback, loopback } = await consent.promise;
        if (loopback) {
          await page
            .getByLabel("Address of the page you landed on", { exact: true })
            .fill(callback);
          await page.getByRole("button", { name: "Connect account", exact: true }).click();
        }
        assert.equal((await completed).status(), 200);
        await page.goto(appUrl);
        await page.getByRole("button", { name: "Connect new account", exact: true }).waitFor();
        await page.screenshot({
          path: join(directory, "zoho-mcp-connected-1280.png"),
          animations: "disabled",
        });
        check("hosted masked endpoint flow completes OAuth", true, true);
        check("hosted connect has no browser errors", errors, []);
      } catch (error) {
        for (const [index, current] of context.pages().entries()) {
          await current
            .screenshot({
              path: join(directory, `browser-failure-${index}.png`),
              animations: "disabled",
            })
            .catch(() => undefined);
          await writeFile(
            join(directory, `browser-failure-${index}.txt`),
            await current
              .locator("body")
              .innerText()
              .catch(() => "Page unavailable"),
          );
        }
        throw error;
      } finally {
        await writeFile(join(directory, "browser-events.json"), JSON.stringify(events, null, 2));
      }
    });
  });
}
