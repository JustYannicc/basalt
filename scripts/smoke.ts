import assert from "node:assert/strict";
import { brand } from "../brand.ts";
import { afterFreshDns } from "./fresh-dns.ts";
import { waitForPublicSite } from "./site-readiness.ts";
import { visibleText } from "./visible-text.ts";

const origin = `https://${brand.host}`;
await waitForPublicSite(brand.site.url);
// A first deploy creates the custom domain moments before this check runs.
const root = await afterFreshDns(() => fetch(origin, { redirect: "manual" }));
assert.equal(root.status, 302, "A signed-out homepage must send people to sign-in");
assert.equal(root.headers.get("location"), "/login");
const login = await fetch(`${origin}/login`);
assert.equal(login.status, 200, "Sign-in page must load");
const page = await login.text();
assert.ok(page.includes(`<title>${brand.name}</title>`), "Sign-in must carry the brand's title");
assert.ok(page.includes(`<link rel="icon" href="${brand.logo}"/>`), "Sign-in must use the logo");
assert.doesNotMatch(visibleText(page), /executor/i, "Sign-in must not show the tools service's name");
for (const path of [brand.logo, "/favicon.png"]) {
  const logo = await fetch(`${origin}${path}`);
  assert.equal(logo.status, 200, `${path} must serve the logo`);
  assert.equal(logo.headers.get("content-type"), "image/png", `${path} must be a PNG`);
}
const resource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
assert.equal((await resource.json()).resource_name, brand.name, "MCP metadata must name the brand");
const catalog = await fetch(`${origin}/catalog/index.json`, { redirect: "manual" });
assert.equal(catalog.status, 200, "Hosted connector catalog must load");
const feed: { version: number; apps: { package: string; connectionNotices?: unknown[] }[] } = await catalog.json();
assert.equal(feed.version, 1, "Hosted connector catalog must use the supported feed version");
for (const entry of feed.apps)
  assert.ok(!entry.connectionNotices?.length, `${entry.package} must list with its description only`);
const pool = await fetch(`${origin}/v1/models`);
assert.equal(pool.status, 401, "Pool backend must reject an unauthenticated model request");
for (const path of ["/v0/management", "/v0/management/config", "/v8/management", "/v8/management/config"]) {
  const management = await fetch(`${origin}${path}`, { redirect: "manual" });
  assert.equal(management.status, 404, `${path} must not expose Home management publicly`);
}
const control = await fetch(`${origin}/pool/v1/pool`);
assert.equal(control.status, 401, "The pool control API must reject a request without a pool token");
const mcp = await fetch(`${origin}/mcp`, { redirect: "manual" });
assert.equal(mcp.status, 401, "MCP must require authentication");
console.log(
  "Public routing, brand, sign-in page and connector feed passed. Interactive connections still need verification.",
);
