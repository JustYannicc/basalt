import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { marketplaceHeaderNames, startZendeskFixtures, zendeskScopes } from "./zendesk-fixture.mjs";

const metadata = {
  "X-Zendesk-Marketplace-Name": "Basalt test fixture",
  "X-Zendesk-Marketplace-Organization-Id": "fixture-organization",
  "X-Zendesk-Marketplace-App-Id": "fixture-app",
};
const fixture = await startZendeskFixtures({ marketplaceHeaders: metadata });
after(() => fixture.stop());

async function authorizeAndExchange(site, mode) {
  const client = fixture.client(site.id, mode);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUUID();
  const callback = "http://127.0.0.1:41119/api/oauth/callback";
  const authorization = new URL("/oauth/authorizations/new", site.origin);
  authorization.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: callback,
    response_type: "code",
    scope: zendeskScopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const authorized = await fetch(authorization, { redirect: "manual" });
  assert.equal(authorized.status, 302);
  const callbackUrl = new URL(authorized.headers.get("location"));
  assert.equal(callbackUrl.origin, new URL(callback).origin);
  assert.equal(callbackUrl.pathname, new URL(callback).pathname);
  assert.equal(callbackUrl.searchParams.get("state"), state);

  const tokenBody = {
    grant_type: "authorization_code",
    client_id: client.clientId,
    code: callbackUrl.searchParams.get("code"),
    redirect_uri: callback,
    code_verifier: verifier,
    ...(mode === "public" ? {} : { client_secret: client.clientSecret }),
  };
  const exchanged = await fetch(new URL("/oauth/tokens", site.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tokenBody),
  });
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.headers.get("cache-control"), "no-store");
  const first = await exchanged.json();
  assert.equal(first.expires_in, 1);
  assert.ok(first.access_token && first.refresh_token);
  return { client, callbackUrl, first };
}

async function readCurrentUser(site, token) {
  return fetch(new URL("/api/v2/users/me.json", site.origin), {
    headers: {
      authorization: `Bearer ${token}`,
      ...metadata,
    },
  });
}

test("two Zendesk fixtures exercise stored public, confidential BYO, and hosted-client JSON PKCE", async () => {
  assert.equal(fixture.sites.length, 2);
  assert.notEqual(fixture.sites[0].origin, fixture.sites[1].origin);

  const issued = [];
  for (const site of fixture.sites) {
    for (const mode of ["public", "confidential", "hosted"]) {
      const { client, first } = await authorizeAndExchange(site, mode);
      assert.equal((await readCurrentUser(site, first.access_token)).status, 200);
      const refreshBody = {
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: first.refresh_token,
        ...(mode === "public" ? {} : { client_secret: client.clientSecret }),
      };
      const refreshed = await fetch(new URL("/oauth/tokens", site.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(refreshBody),
      });
      assert.equal(refreshed.status, 200);
      const second = await refreshed.json();
      assert.notEqual(second.access_token, first.access_token);
      assert.notEqual(second.refresh_token, first.refresh_token);
      assert.equal((await readCurrentUser(site, first.access_token)).status, 401, "Rotation invalidates the old access token");
      assert.equal((await readCurrentUser(site, second.access_token)).status, 200);
      issued.push({ site, mode, token: second.access_token, client, first, second });
    }
  }

  const wrongSite = await readCurrentUser(issued[0].site === fixture.sites[0] ? fixture.sites[1] : fixture.sites[0], issued[0].token);
  assert.equal(wrongSite.status, 401, "A token issued for one mock site cannot be placed at its peer");
  assert.deepEqual(fixture.failures(), []);

  const events = fixture.observations();
  assert.equal(events.filter((event) => event.phase === "authorization").length, 6);
  assert.equal(events.filter((event) => event.phase === "token_exchange").length, 6);
  assert.equal(events.filter((event) => event.phase === "token_refresh").length, 6);
  for (const event of events.filter((entry) => entry.phase === "authorization")) {
    assert.equal(event.pkceMethod, "S256");
    assert.equal(event.pkceChallengePresent, true);
    assert.deepEqual(event.scopes, [...zendeskScopes].sort());
  }
  const tokenEvents = events.filter((entry) => entry.phase.startsWith("token_"));
  for (const event of tokenEvents) {
    assert.equal(event.contentType, "application/json");
    assert.equal(event.basicAuthPresent, false);
  }
  assert.deepEqual(tokenEvents.map((event) => event.authMethod).sort(), [
    "client_secret_post", "client_secret_post", "client_secret_post", "client_secret_post",
    "client_secret_post", "client_secret_post", "client_secret_post", "client_secret_post",
    "none", "none", "none", "none",
  ].sort());
  for (const site of fixture.sites) {
    const hosted = events.filter((event) => event.flowMode === "hosted" && event.site === site.id);
    assert.ok(hosted.some((event) => event.phase === "token_exchange" && event.clientSecretInJson));
    assert.ok(hosted.some((event) => event.phase === "token_refresh" && event.clientSecretInJson && event.rotated));
  }
  for (const event of events.filter((entry) => entry.phase === "api" && entry.credentialSiteMatches)) {
    assert.equal(event.marketplaceHeadersMatched, true);
    assert.deepEqual(event.marketplaceHeaderNames, [...marketplaceHeaderNames]);
  }
  assert.ok(events.some((event) => event.phase === "api" && !event.credentialSiteMatches));
  assert.deepEqual(fixture.rotations().map(({ site, mode, generation, rotated }) => ({ site, mode, generation, rotated })), [
    { site: "site-a", mode: "public", generation: 1, rotated: true },
    { site: "site-a", mode: "confidential", generation: 1, rotated: true },
    { site: "site-a", mode: "hosted", generation: 1, rotated: true },
    { site: "site-b", mode: "public", generation: 1, rotated: true },
    { site: "site-b", mode: "confidential", generation: 1, rotated: true },
    { site: "site-b", mode: "hosted", generation: 1, rotated: true },
  ]);

  const safeEvidence = JSON.stringify({ events, failures: fixture.failures() });
  for (const { client, first, second } of issued) {
    for (const privateValue of [
      first.access_token,
      first.refresh_token,
      second.access_token,
      second.refresh_token,
      client.clientSecret,
    ].filter(Boolean))
      assert.equal(safeEvidence.includes(privateValue), false);
  }
});
