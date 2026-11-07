import assert from "node:assert/strict";
import { protocol35Framework } from "../.upstream/e2e/support/app-package.ts";

/** Keep an earlier REST consumer running while another app adds per-account MCP sign-in. */
export function installRetainedPeopleConsumer({ Effect, files, request, prefix, check }) {
  return Effect.gen(function* () {
    const retained = yield* protocol35Framework;
    const legacyFiles = files.map((file) => {
      if (file.path === "package.json")
        return {
          ...file,
          content: JSON.stringify({
            ...JSON.parse(file.content),
            dependencies: { ...JSON.parse(file.content).dependencies, apps: retained },
          }),
        };
      if (file.path === "provider.ts") {
        const content = file.content
          .replace(/    mcp: oauth2\(\{[\s\S]*?^    \}\),\n/mu, "")
          .replace(/    if \(account.method === "mcp"\) \{[\s\S]*?^    \}\n/mu, "");
        assert.equal(content.includes("mcpEndpoint"), false);
        return { ...file, content };
      }
      if (file.path === "index.ts")
        return {
          ...file,
          content: `
import { accountRouter, defineApp, json, object, query, router } from "apps";
import { people } from "./provider.js";
import { createRequest } from "./request.js";
import definitions from "./operations.json" with { type: "json" };
const definition = definitions.find(item => item.area === "timeTracker" && item.name === "listTimeLogs");
export default defineApp({ user: { accounts: { people: people.many() } } }, async ({ user, fetch, signal }) => ({
  tools: await accountRouter(user?.accounts.people ?? [], account => router({
    read: query({ input: object({}), output: json() }, async () =>
      createRequest(account, fetch, signal)(definition, { query: { user: "employee-fixture" } })),
  }), { signal }),
}));`,
        };
      return file;
    });
    const app = yield* request("POST", `${prefix}/apps/deploy`, {
      name: "Retained People REST consumer",
      files: legacyFiles,
    });
    const path = `${prefix}/apps/${app.id}`;
    return {
      app,
      files: legacyFiles,
      prove: (account) =>
        Effect.gen(function* () {
          yield* request("PUT", `${path}/accounts/user/people/${account.id}`);
          const response = yield* request("POST", `${path}/tools/call`, {
            tool: "read",
            input: { accountId: account.id, input: {} },
          });
          check("protocol 35 REST consumer still calls its service", response.response.result, []);
        }),
    };
  });
}
