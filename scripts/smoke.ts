import assert from "node:assert/strict";
import { brand } from "../brand.ts";
import { afterFreshDns } from "./fresh-dns.ts";
import { waitForPoolStatus } from "./pool-readiness.ts";
import { waitForPublicSite } from "./site-readiness.ts";
import { visibleText } from "./visible-text.ts";

const origin = `https://${brand.host}`;
console.log("[smoke] Public site homepage");
await waitForPublicSite(brand.site.url);
// A first deploy creates the custom domain moments before this check runs.
console.log("[smoke] Signed-out homepage GET /");
const root = await afterFreshDns(() => fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(10_000) }));
assert.equal(root.status, 302, "A signed-out homepage must send people to sign-in");
assert.equal(root.headers.get("location"), "/login");
console.log("[smoke] Sign-in page GET /login");
const login = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(10_000) });
assert.equal(login.status, 200, "Sign-in page must load");
const page = await login.text();
assert.ok(page.includes(`<title>${brand.name}</title>`), "Sign-in must carry the brand's title");
assert.ok(page.includes(`<link rel="icon" href="${brand.logo}"/>`), "Sign-in must use the logo");
assert.doesNotMatch(visibleText(page), /executor/i, "Sign-in must not show the tools service's name");
for (const path of [brand.logo, "/favicon.png"]) {
  console.log(`[smoke] Logo GET ${path}`);
  const logo = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(logo.status, 200, `${path} must serve the logo`);
  assert.equal(logo.headers.get("content-type"), "image/png", `${path} must be a PNG`);
}
console.log("[smoke] MCP metadata GET /.well-known/oauth-protected-resource/mcp");
const resource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(10_000) });
assert.equal((await resource.json()).resource_name, brand.name, "MCP metadata must name the brand");
console.log("[smoke] Connector catalog GET /catalog/index.json");
const catalog = await fetch(`${origin}/catalog/index.json`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
assert.equal(catalog.status, 200, "Hosted connector catalog must load");
const feed: { version: number; apps: { package: string; connectionNotices?: unknown[] }[] } = await catalog.json();
assert.equal(feed.version, 1, "Hosted connector catalog must use the supported feed version");
for (const entry of feed.apps)
  assert.ok(!entry.connectionNotices?.length, `${entry.package} must list with its description only`);
console.log("[smoke] Pool model authentication GET /v1/models");
await waitForPoolStatus("Pool model authentication GET /v1/models", 401,
  (signal) => fetch(`${origin}/v1/models`, { redirect: "manual", signal }));
for (const path of ["/v0/management", "/v0/management/config", "/v8/management", "/v8/management/config"]) {
  console.log(`[smoke] Private management GET ${path}`);
  const management = await fetch(`${origin}${path}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  assert.equal(management.status, 404, `${path} must not expose Home management publicly`);
}
console.log("[smoke] Pool control authentication GET /pool/v1/pool");
await waitForPoolStatus("Pool control authentication GET /pool/v1/pool", 401,
  (signal) => fetch(`${origin}/pool/v1/pool`, { redirect: "manual", signal }));
console.log("[smoke] MCP authentication GET /mcp");
const mcp = await fetch(`${origin}/mcp`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
assert.equal(mcp.status, 401, "MCP must require authentication");
console.log(
  "Public routing, brand, sign-in page and connector feed passed. Interactive connections still need verification.",
);
