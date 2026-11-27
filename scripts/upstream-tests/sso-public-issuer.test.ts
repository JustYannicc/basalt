import assert from "node:assert/strict";
import { test } from "node:test";

// The SSO library the Cloud registers providers with. Registering an OIDC provider runs the
// library's discovery: the discovery URL computed from the issuer is checked, the document it
// serves is checked against the issuer, and its endpoints are normalized into the provider's
// configuration. Each step is exported, so a public issuer registering is proved here with the
// document in the test's hands and nothing fetched. The local E2E stack has no public issuer (#1970).
const {
  computeDiscoveryUrl,
  normalizeDiscoveryUrls,
  selectTokenEndpointAuthMethod,
  validateDiscoveryDocument,
  validateDiscoveryUrl,
} = await import(
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
/** The Cloud trusts only its own origins; none of these issuers is one. */
const untrusted = () => false;

test("a public issuer's discovery is accepted and yields the provider's endpoints", () => {
  const discovery = computeDiscoveryUrl(issuer);
  assert.equal(discovery, `${issuer}/.well-known/openid-configuration`);
  validateDiscoveryUrl(discovery, untrusted);
  validateDiscoveryDocument(document, issuer);
  const normalized = normalizeDiscoveryUrls(document, issuer, untrusted);
  assert.equal(normalized.authorization_endpoint, document.authorization_endpoint);
  assert.equal(normalized.token_endpoint, document.token_endpoint);
  assert.equal(normalized.jwks_uri, document.jwks_uri);
  assert.equal(selectTokenEndpointAuthMethod(normalized), "client_secret_basic");
});

test("a loopback or link-local issuer is refused before discovery is fetched", () => {
  for (const refused of [
    "http://localhost:21234",
    "http://127.0.0.1:21234",
    "http://169.254.169.254",
  ])
    assert.throws(
      () => validateDiscoveryUrl(computeDiscoveryUrl(refused), untrusted),
      (error: { code?: string }) => error.code === "discovery_private_host",
      refused,
    );
});

test("a discovery document naming another issuer is refused", () => {
  assert.throws(
    () => validateDiscoveryDocument({ ...document, issuer: "https://other.example.com" }, issuer),
    (error: { code?: string }) => error.code === "issuer_mismatch",
  );
});
