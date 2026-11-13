import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-evidence.ts";
import { oauthFitness, oauthReviews } from "./oauth-policy.ts";
import type { Feed } from "./feed.ts";
import reviewData from "./oauth-reviews.json" with { type: "json" };
import workosMetadata from "./workos.oauth-metadata.json" with { type: "json" };

test("WorkOS's reviewed token-revocation addition still refuses metadata drift", () => {
  const { revocation_endpoint, revocation_endpoint_auth_methods_supported, ...previous } =
    workosMetadata;
  assert.equal(revocation_endpoint, "https://signin.workos.com/oauth2/revoke");
  assert.deepEqual(revocation_endpoint_auth_methods_supported, [
    "none",
    "client_secret_post",
    "client_secret_basic",
    "private_key_jwt",
  ]);
  // These two RFC 7009 fields are additive; every previously reviewed field is unchanged.
  assert.equal(
    catalogDocumentSha256(previous),
    "e803c89a2dcd92f4391b1857923793d3b18add3764d3d3b882fdb55c1b97bf12",
  );
  assert.equal(workosMetadata.authorization_response_iss_parameter_supported, true);
  const review = oauthReviews(reviewData).find((item) => item.entry === "workos")!;
  const method = review.methods.oauth!;
  assert.equal(method.kind, "automatic");
  if (method.kind !== "automatic") throw new Error("WorkOS must use reviewed automatic metadata");
  assert.equal(method.metadata, "https://signin.workos.com/.well-known/oauth-authorization-server");
  const feed: Feed = {
    version: 1,
    apps: [
      {
        id: "workos",
        package: review.package,
        name: "WorkOS",
        description: "Identity management",
        auth: [{ method: "oauth", kind: "oauth2" }],
        icons: [],
        source: "apps/workos.json",
      },
    ],
  };
  const check = (document: unknown) =>
    oauthFitness(feed, [review], {
      sources: new Map([["workos", review.sourceSha256!]]),
      hostedClients: new Set<string>(),
      metadata: new Map([[method.metadata, { document, sha256: catalogDocumentSha256(document) }]]),
    });
  assert.deepEqual(check(workosMetadata), []);
  for (const change of [
    { issuer: "https://unreviewed.example" },
    { authorization_endpoint: "https://unreviewed.example/authorize" },
    { token_endpoint: "https://unreviewed.example/token" },
    { scopes_supported: [...workosMetadata.scopes_supported, "unreviewed:scope"] },
    { authorization_response_iss_parameter_supported: false },
    { client_id_metadata_document_supported: false },
    { code_challenge_methods_supported: ["plain"] },
    { grant_types_supported: ["client_credentials"] },
    { revocation_endpoint: "https://unreviewed.example/revoke" },
    { unreviewed_capability: true },
  ]) {
    assert.deepEqual(check({ ...workosMetadata, ...change }), [
      `workos/oauth: automatic client metadata changed (metadataSha256: ${method.metadataSha256} -> ${catalogDocumentSha256({ ...workosMetadata, ...change })})`,
    ]);
  }
});
