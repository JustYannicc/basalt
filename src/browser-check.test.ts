import assert from "node:assert/strict";
import { test } from "node:test";
import { isControlPath } from "../apps/pool/contract.ts";
import { apiPathsExpression, isApiPath } from "./browser-check.ts";
import { catalog } from "./catalog/settings.ts";
import { isPublicModelPath } from "./pool/lifecycle.ts";

const host = "app.signalbox.run";
const exempt = [
  "/mcp", "/org/acme/mcp", "/git/acme/tool.git/info/refs", "/v1", "/v1/models", "/messages", "/chat/completions", "/completions",
  "/pool/v1", "/pool/v1/accounts", `${catalog.path}index.json`, "/.well-known/oauth-protected-resource/mcp",
  "/api/auth/oauth2/token", "/api/organizations/x", "/api/webhooks/workos", "/openapi.json",
  "/oauth/client-metadata.json", "/setup/client.mjs", `/setup/claim/${"a".repeat(64)}`,
];
const checked = [
  "/", "/login", "/mcp/authorize", "/mcp/approve/x", "/setup", "/setup/v1/links", "/pricing", "/org/acme", "/org/acme/settings", "/v10", "/mcpx",
  "/v1x", "/apix", "/messages/x", "/__telemetry/v1/analytics", "/feedback/v1/error",
];

/** Evaluates the subset of the Rules language `apiPathsExpression` emits, for one path. */
function evaluate(expression: string, path: string): boolean {
  const js = expression
    .replaceAll("http.request.uri.path", "path")
    .replace(/http\.host eq "([^"]+)"/, (_, value) => JSON.stringify(value === host))
    .replace(/path in \{([^}]*)\}/, (_, values) => `[${values.trim().split(/\s+/).join(",")}].includes(path)`)
    .replace(/starts_with\(path, ("[^"]*")\)/g, "path.startsWith($1)")
    .replace(/ends_with\(path, ("[^"]*")\)/g, "path.endsWith($1)")
    .replaceAll(" and ", " && ")
    .replaceAll(" or ", " || ");
  return new Function("path", `return ${js};`)(path) as boolean;
}

test("non-browser routes skip the check and browser pages keep it", () => {
  const expression = apiPathsExpression(host);
  for (const path of exempt) assert.ok(isApiPath(path) && evaluate(expression, path), path);
  for (const path of checked) assert.ok(!isApiPath(path) && !evaluate(expression, path), path);
  assert.throws(() => apiPathsExpression('app.signalbox.run" or true or "'), /plain DNS name/);
});

test("every path the router sends to the model gateway or pool control API is exempt", () => {
  for (const path of [...exempt, ...checked]) {
    if (isPublicModelPath(path) || isControlPath(path)) assert.ok(isApiPath(path), path);
  }
});
