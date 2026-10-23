import assert from "node:assert/strict";
import { brand } from "../brand.ts";

const origin = `https://${brand.host}`;
const root = await fetch(origin, { redirect: "manual" });
assert.equal(root.status, 307, "Signed-out homepage must lead to sign-in");
assert.equal(new URL(root.headers.get("location")!, origin).pathname, "/login");
const login = await fetch(`${origin}/login`);
assert.equal(login.status, 200, "Sign-in page must load");
const pool = await fetch(`${origin}/v1/models`);
assert.equal(pool.status, 503, "Pool backend must stay unimplemented");
assert.equal(await pool.text(), "");
const mcp = await fetch(`${origin}/mcp`, { redirect: "manual" });
assert.equal(mcp.status, 401, "MCP must require authentication");
console.log(
  "Public routing and sign-in page passed. Interactive Google sign-in still needs verification.",
);
