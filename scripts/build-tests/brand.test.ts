import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Redacted } from "effect";
import { brand } from "../../brand.ts";
import { visibleText } from "../visible-text.ts";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const dashboard = `${upstream}apps/hosted/cloud/web/dist/server/server.js`;
// A name and logo nothing in the tools service ships, so every hit comes from configuration.
const swapped = { name: "Quartz Lantern", logo: "/quartz-lantern.png" };
const executor = /executor/i;

/** Render a public page from the built dashboard the deploy uploads, as its Worker would. */
async function render(path: string, product: { name: string; logo: string }) {
  const server = (await import(dashboard)).default as {
    fetch(request: Request, options: { context: unknown }): Promise<Response>;
  };
  const origin = `https://${brand.host}`;
  const response = await server.fetch(new Request(`${origin}${path}`), {
    context: {
      apiFetch: async () => Response.json(null),
      path,
      display: { locale: "en-US", timeZone: "UTC" },
      session: null,
      lastOrganization: null,
      resourceOrigins: { mcp: [origin], api: [origin] },
      brand: product,
      entry: path.startsWith("/login")
        ? { kind: "page", path, session: null, onboarding: null, passkeyEnrollment: false }
        : null,
      formerPasskeyHost: null,
      documentation: `${origin}/docs/`,
    },
  });
  assert.equal(response.status, 200, `${path} renders`);
  return response.text();
}

test("the MCP entry name is the one the tools service derives from the name", async () => {
  const { productServerName } = await import(`${upstream}packages/utils/src/product-brand.ts`);
  assert.equal(productServerName({ name: brand.name, logo: brand.logo }), brand.mcpServerName);
});

for (const product of [{ name: brand.name, logo: brand.logo }, swapped]) {
  test(`built sign-in pages present ${product.name} and never the tools service's name`, async () => {
    for (const path of ["/login", "/login/sso", "/email/unsubscribe?result=invalid"]) {
      const html = await render(path, product);
      assert.ok(html.includes(`<title>${product.name}</title>`), `${path} title`);
      assert.ok(html.includes(`<link rel="icon" href="${product.logo}"/>`), `${path} favicon`);
      const text = visibleText(html);
      assert.ok(text.includes(product.name), `${path} names the product`);
      assert.doesNotMatch(text, executor, `${path} shows no tools-service name`);
    }
  });

  test(`patched emails and fallback pages present ${product.name}`, async () => {
    const { emailCodeMessage, invitationEmailMessage } = await import(
      `${upstream}apps/hosted/cloud/src/implementation/email-messages.ts`
    );
    const { unavailablePage } = await import(
      `${upstream}packages/dashboard-start/src/implementation/document.ts`
    );
    const origin = `https://${brand.host}`;
    const messages = [
      emailCodeMessage({ email: "person@example.test", otp: "123456", type: "sign-in", brand: product }),
      emailCodeMessage({ email: "person@example.test", otp: "123456", type: "change-email", brand: product }),
      invitationEmailMessage({
        email: "person@example.test",
        id: "invitation",
        organizationName: "Team",
        origin,
        brand: product,
      }),
    ];
    for (const message of messages) {
      const text = Redacted.value(message.text) as string;
      const html = Redacted.value(message.html) as string;
      assert.ok(message.subject.includes(product.name), message.subject);
      for (const body of [message.subject, text, visibleText(html)])
        assert.doesNotMatch(body, executor, message.subject);
      assert.ok(text.includes(product.name));
    }
    assert.ok(
      (Redacted.value(messages[2].html) as string).includes(`src="${origin}${product.logo}"`),
      "invitation shows the configured logo",
    );
    const page = unavailablePage(product.name);
    assert.ok(page.includes(`Unable to open ${product.name}`));
    assert.doesNotMatch(page, executor);
  });
}

test("the router keeps the tools service's own site off the public host", async () => {
  const { sitePageRoutes, siteFiles } = await import(
    `${upstream}apps/hosted/cloud/src/contracts/site-paths.ts`
  );
  const { toolsServiceSitePages, toolsServiceSiteFiles, sessionCookiePrefix, notFoundPage } =
    await import("../../src/router.ts");
  assert.deepEqual([...toolsServiceSitePages], sitePageRoutes, "update the router's site pages");
  assert.deepEqual([...toolsServiceSiteFiles], siteFiles, "update the router's site files");
  const { cloudSessionCookiePrefix } = await import(
    `${upstream}apps/hosted/cloud/src/contracts/browser.ts`
  );
  assert.equal(
    cloudSessionCookiePrefix(`https://${brand.host}`),
    sessionCookiePrefix,
    "the router's session cookie prefix must be the cloud deployment's",
  );
  // The tools service's built 404 page is the one the router replaces; the replacement is ours.
  const marketing = readFileSync(`${upstream}apps/hosted/cloud/.generated/site/404.html`, "utf8");
  assert.match(visibleText(marketing), executor, "the built 404 page is still the tools service's");
  for (const product of [brand, swapped]) {
    const replacement = await notFoundPage(product).text();
    assert.ok(visibleText(replacement).includes(product.name), product.name);
    assert.ok(replacement.includes(`href="${product.logo}"`), product.name);
    assert.doesNotMatch(visibleText(replacement), executor);
  }
  // The icon paths the tools service's site uses all show the brand's logo.
  const redirects = readFileSync(new URL("../../public/_redirects", import.meta.url), "utf8");
  for (const icon of ["/favicon.png", "/favicon-32.png", "/favicon-192.png", "/apple-touch-icon.png"])
    assert.ok(redirects.includes(`${icon} ${brand.logo} 200`), icon);
});
