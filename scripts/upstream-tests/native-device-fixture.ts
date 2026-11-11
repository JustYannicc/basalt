import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Effect, Option, Redacted } from "effect";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { authOptions } from "../../.upstream/apps/hosted/server/src/implementation/auth.ts";
import { provisionHostedOAuthResources } from "../../.upstream/apps/hosted/server/src/implementation/mcp-oauth.ts";
const origin = "http://localhost:3000";
const verifier = "v".repeat(43);

export async function fixture(
  control?: (request: Request) => Promise<Response>,
  signingKey = "ab".repeat(32),
) {
  const key = Option.some(Redacted.make(signingKey));
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
    oauthResource: [],
    oauthClientResource: [],
    oauthClient: [],
    oauthConsent: [],
    oauthAccessToken: [],
    oauthRefreshToken: [],
    mcpGrant: [],
    mcpConnection: [],
  };
  const auth = betterAuth({
    ...authOptions(
      {
        url: origin,
        issuer: `${origin}/api/auth`,
        resourceOrigins: { api: [origin], mcp: [origin] },
        oauthRedirectUri: Option.none(),
        nativeSigningKey: key,
      },
      [],
    ),
    secret: "synthetic-native-approval-auth-secret",
    database: memoryAdapter(db),
    rateLimit: { enabled: false },
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
  });
  await Effect.runPromise(
    provisionHostedOAuthResources(
      { origin, issuer: `${origin}/api/auth`, resourceOrigins: { api: [origin], mcp: [origin] } },
      await auth.$context,
      key,
    ),
  );
  const signup = await auth.api.signUpEmail({
    asResponse: true,
    body: {
      name: "Device owner",
      email: "device-owner@example.invalid",
      password: "synthetic-device-password",
    },
  });
  assert.equal(signup.status, 200);
  db.user[0]!.emailVerified = true;
  const signedIn = await auth.api.signInEmail({
    asResponse: true,
    body: { email: "device-owner@example.invalid", password: "synthetic-device-password" },
  });
  assert.equal(signedIn.status, 200);
  const cookies = signedIn.headers
    .getSetCookie()
    .map((value: string) => value.split(";")[0])
    .join("; ");
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie: cookies, "content-type": "application/json", ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const sessionResponse = await request("/get-session?disableCookieCache=true&disableRefresh=true");
  assert.ok((await sessionResponse.json())?.user, "the fixture must have a signed-in browser");
  const registration = await request(
    "/oauth2/register",
    {
      client_name: "Synthetic native client",
      token_endpoint_auth_method: "none",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      response_types: [],
      scope: "native offline_access",
    },
    { cookie: "" },
  );
  assert.equal(registration.status, 201, await registration.clone().text());
  const { client_id } = await registration.json();
  const started = await auth.handler(
    new Request(`${origin}/api/auth/oauth2/device-authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        scope: "native offline_access",
        resource: `${origin}/native`,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }),
    }),
  );
  assert.equal(started.status, 200, await started.clone().text());
  const { user_code, device_code } = await started.json();
  const oldFetch = globalThis.fetch;
  if (control) globalThis.fetch = async (input, init) => control(new Request(input, init));
  return {
    request,
    raw: (path: string, init: RequestInit) =>
      auth.handler(new Request(`${origin}/api/auth${path}`, init)),
    user_code,
    device_code,
    client_id,
    verifier,
    db,
    [Symbol.dispose]() {
      if (control) globalThis.fetch = oldFetch;
    },
  };
}
