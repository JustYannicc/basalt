import assert from "node:assert/strict";
import { test } from "node:test";

// The SSO library the Cloud registers providers with. Registration hydrates an OIDC provider from
// its issuer's discovery document through this function, so a public issuer registering is proved
// here, with the document in the test's hands. The local E2E stack has no public issuer (#1970).
const { discoverOIDCConfig } = await import(
  new URL(
    "../../.upstream/apps/hosted/cloud/node_modules/@better-auth/sso/dist/index.mjs",
    import.meta.url,
  ).href
);

const issuer = "https://idp.example.com";
const document = {
  issuer,
  authorization_endpoint: `${issuer}/oauth2/authorize`,
  token_endpoint: `${issuer}/oauth2/token`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  userinfo_endpoint: `${issuer}/oauth2/userinfo`,
  token_endpoint_auth_methods_supported: ["client_secret_basic"],
  scopes_supported: ["openid", "email", "profile"],
};

/** Serve `document` at the issuer's discovery URL for the duration of `run`, recording requests. */
const withIssuer = async <A>(run: (requested: string[]) => Promise<A>) => {
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    return url === `${issuer}/.well-known/openid-configuration`
      ? Response.json(document)
      : new Response("not found", { status: 404 });
  };
  try {
    return await run(requested);
  } finally {
    globalThis.fetch = original;
  }
};

const untrusted = () => false;

test("a public issuer registers from its discovery document", () =>
  withIssuer(async (requested) => {
    const config = await discoverOIDCConfig({ issuer, isTrustedOrigin: untrusted });
    assert.equal(config.issuer, issuer);
    assert.equal(config.authorizationEndpoint, document.authorization_endpoint);
    assert.equal(config.tokenEndpoint, document.token_endpoint);
    assert.equal(config.jwksEndpoint, document.jwks_uri);
    assert.deepEqual(requested, [`${issuer}/.well-known/openid-configuration`]);
  }));

test("a loopback or link-local issuer is refused before anything is fetched", () =>
  withIssuer(async (requested) => {
    for (const refused of [
      "http://localhost:21234",
      "http://127.0.0.1:21234",
      "http://169.254.169.254",
    ])
      await assert.rejects(
        discoverOIDCConfig({ issuer: refused, isTrustedOrigin: untrusted }),
        (error: { code?: string }) => error.code === "discovery_private_host",
        refused,
      );
    assert.deepEqual(requested, []);
  }));
