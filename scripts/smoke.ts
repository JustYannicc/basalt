import assert from "node:assert/strict";
import { brand } from "../brand.ts";
import { visibleText } from "./visible-text.ts";

const origin = `https://${brand.host}`;
const root = await fetch(origin, { redirect: "manual" });
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
const pool = await fetch(`${origin}/v1/models`);
assert.equal(pool.status, 401, "Pool backend must reject an unauthenticated model request");
const mcp = await fetch(`${origin}/mcp`, { redirect: "manual" });
assert.equal(mcp.status, 401, "MCP must require authentication");
console.log(
  "Public routing, brand and sign-in page passed. Interactive Google sign-in still needs verification.",
);
