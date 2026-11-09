import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-evidence.ts";
import { oauthFitness, oauthReviews } from "./oauth-policy.ts";
import type { Feed } from "./feed.ts";
import reviewData from "./oauth-reviews.json" with { type: "json" };
import workosMetadata from "./workos.oauth-metadata.json" with { type: "json" };

test("WorkOS's reviewed issuer-response capability still refuses metadata drift", () => {
  // RFC 9207 advertises issuer identification in authorization responses.
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
    { unreviewed_capability: true },
  ]) {
    assert.deepEqual(check({ ...workosMetadata, ...change }), [
      "workos/oauth: automatic client metadata is missing or changed",
    ]);
  }
});
