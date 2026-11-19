import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-metadata.ts";
import { oauthFitness, oauthReviews } from "./oauth-policy.ts";
import type { Feed } from "./feed.ts";
import reviewData from "./oauth-reviews.json" with { type: "json" };
import awsMetadata from "./aws.oauth-metadata.json" with { type: "json" };

test("AWS's reviewed JWT-bearer grant addition still refuses metadata drift", () => {
  const jwtBearer = "urn:ietf:params:oauth:grant-type:jwt-bearer";
  const { authorization_grant_profiles_supported, ...rest } = awsMetadata;
  assert.deepEqual(authorization_grant_profiles_supported, [
    "urn:ietf:params:oauth:grant-profile:id-jag",
  ]);
  assert.ok(awsMetadata.grant_types_supported.includes(jwtBearer));
  // Enterprise identity-assertion grants are additive; registration still asks only for
  // authorization_code and refresh_token, and every previously reviewed field is unchanged.
  const previous = {
    ...rest,
    grant_types_supported: awsMetadata.grant_types_supported.filter((grant) => grant !== jwtBearer),
  };
  assert.equal(
    catalogDocumentSha256(previous),
    "608120a97f05525e4ee05dbfcb3da4b8e20f5685c1a546b45c3a7baa73bfa11e",
  );
  const review = oauthReviews(reviewData).find((item) => item.entry === "aws")!;
  const method = review.methods.oauth!;
  assert.equal(method.kind, "automatic");
  if (method.kind !== "automatic") throw new Error("AWS must use reviewed automatic metadata");
  assert.equal(
    method.metadata,
    "https://us-east-1.oauth.signin.aws/.well-known/oauth-authorization-server",
  );
  const feed: Feed = {
    version: 1,
    apps: [
      {
        id: "aws",
        package: review.package,
        name: "AWS",
        description: "Cloud services",
        auth: [{ method: "oauth", kind: "oauth2" }],
        icons: [],
        source: "apps/aws.json",
      },
    ],
  };
  const check = (document: unknown) =>
    oauthFitness(feed, [review], {
      sources: new Map([["aws", review.sourceSha256!]]),
      hostedClients: new Set<string>(),
      metadata: new Map([[method.metadata, { document, sha256: catalogDocumentSha256(document) }]]),
    });
  assert.deepEqual(check(awsMetadata), []);
  for (const document of [
    previous,
    ...[
      { issuer: "https://unreviewed.example" },
      { authorization_endpoint: "https://unreviewed.example/authorize" },
      { token_endpoint: "https://unreviewed.example/token" },
      { registration_endpoint: "https://unreviewed.example/register" },
      { token_endpoint_auth_methods_supported: ["client_secret_basic"] },
      { code_challenge_methods_supported: ["plain"] },
      { grant_types_supported: ["authorization_code"] },
      { authorization_grant_profiles_supported: ["urn:example:unreviewed-profile"] },
      { authorization_response_iss_parameter_supported: true },
      { unreviewed_capability: true },
    ].map((change) => ({ ...awsMetadata, ...change })),
  ]) {
    assert.deepEqual(check(document), [
      `aws/oauth: automatic client metadata changed (metadataSha256: ${method.metadataSha256} -> ${catalogDocumentSha256(document)})`,
    ]);
  }
});
