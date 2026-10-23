import assert from "node:assert/strict";
import { brand } from "../brand.ts";

const origin = `https://${brand.host}`;
const root = await fetch(origin, { redirect: "manual" });
assert.equal(root.status, 200, "Upstream signed-out homepage must load");
const login = await fetch(`${origin}/login`);
assert.equal(login.status, 200, "Sign-in page must load");
const pool = await fetch(`${origin}/v1/models`);
assert.equal(pool.status, 401, "Pool backend must reject an unauthenticated model request");
const mcp = await fetch(`${origin}/mcp`, { redirect: "manual" });
assert.equal(mcp.status, 401, "MCP must require authentication");
console.log(
  "Public routing and sign-in page passed. Interactive Google sign-in still needs verification.",
);
