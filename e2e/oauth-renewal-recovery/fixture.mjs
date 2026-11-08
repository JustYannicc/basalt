import assert from "node:assert/strict";
import { Effect, FetchHttpClient, HttpClient } from "./dependencies.mjs";
import { appsManifest } from "../../.upstream/e2e/support/apps-release.ts";

/** A real deployed provider whose health check resolves and presents its OAuth credentials. */
export const appFiles = (origin) => [
  appsManifest,
  {
    path: "index.ts",
    content: `import { defineApp, defineProvider, oauth2, query, object, router, ProviderError } from "apps";
const service = defineProvider({
  name: "Renewal fixture",
  auth: { oauth: oauth2({ discover: ${JSON.stringify(`${origin}/mcp`)} }) },
  async health({ account, fetch }) {
    const response = await fetch(${JSON.stringify(`${origin}/resource`)}, { headers: { authorization: "Bearer " + account.fields.access_token } });
    if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: account.id });
    if (!response.ok) throw new Error("Synthetic service unavailable");
    return {};
  }
});
export default defineApp({ user: { accounts: { service } } }, async () => ({
  tools: router({ read: query({ input: object({}) }, async () => ({ ok: true })) })
}));`,
  },
];

/** Complete the fixture's initial consent via public connection APIs. Browser recovery comes later. */
export const connect = ({ request, appPath, prefix, label }) =>
  Effect.gen(function* () {
    const connection = yield* request("POST", `${appPath}/accounts/user/service/connections`, {});
    const started = yield* request("POST", `${prefix}/connections/${connection.id}/oauth/start`, {
      method: "oauth",
      label,
    });
    const http = yield* HttpClient.HttpClient;
    const callbackUrl = yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* HttpClient.withScope(http).get(started.authorizationUrl);
        assert.equal(response.status, 302, "Synthetic consent must redirect to the real callback");
        assert.ok(response.headers.location, "Synthetic consent omitted its callback");
        return response.headers.location;
      }),
    ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    return yield* request("POST", `${prefix}/connections/${connection.id}/oauth/complete`, {
      callbackUrl,
    });
  });

/** Neither fixture credentials nor the provider's private error prose may leave the boundary. */
export function assertPrivate(value) {
  const encoded = JSON.stringify(value);
  for (const marker of [
    "PRIVATE_PROVIDER_ERROR",
    "synthetic-access-token",
    "synthetic-refreshed-token",
    "synthetic-refresh-",
    "synthetic-client-secret",
    "access_token",
    "refresh_token",
  ])
    assert.ok(!encoded.includes(marker), `Public evidence exposed forbidden marker ${marker}`);
}
