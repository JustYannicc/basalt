import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-metadata.ts";
import { oauthFitness, oauthReviews } from "./oauth-policy.ts";
import type { Feed } from "./feed.ts";
import reviewData from "./oauth-reviews.json" with { type: "json" };
import clerkMetadata from "./clerk.oauth-metadata.json" with { type: "json" };

test("Clerk's reviewed protected-resource list and browser sign-in scope still refuse metadata drift", () => {
  // Sign-in requests its own declared scopes, never the advertised list, and the host reads no
  // protected-resource list from server metadata, so neither addition changes a grant.
  const addedScope = "poppy:browser-sign-in";
  // Scopes Clerk advertised after that change, each re-pinned by the drift workflow.
  const laterScopes = ["support_tickets:manage"];
  assert.ok(clerkMetadata.scopes_supported.includes(addedScope));
  const { protected_resources: added, ...unchanged } = clerkMetadata;
  assert.deepEqual(added, ["https://clerk.com"]);
  const previous = {
    ...unchanged,
    // Later reviewed additions are not part of the document before #1516's change.
    scopes_supported: clerkMetadata.scopes_supported.filter(
      (scope) => scope !== addedScope && !laterScopes.includes(scope),
    ),
  };
  assert.equal(
    catalogDocumentSha256(previous),
    "158ac5428a3f49d85e6c3ab790e0bba4c2d4b813f163c583477a3e954994f9d9",
  );
  const review = oauthReviews(reviewData).find((item) => item.entry === "clerk")!;
  const method = review.methods.oauth!;
  assert.equal(method.kind, "automatic");
  if (method.kind !== "automatic") throw new Error("Clerk must use reviewed automatic metadata");
  assert.equal(method.metadata, "https://clerk.clerk.com/.well-known/oauth-authorization-server");
  const feed: Feed = {
    version: 1,
    apps: [
      {
        id: "clerk",
        package: review.package,
        name: "Clerk",
        description: "User management",
        auth: [{ method: "oauth", kind: "oauth2" }],
        icons: [],
        source: "apps/clerk.json",
      },
    ],
  };
  const check = (document: unknown) =>
    oauthFitness(feed, [review], {
      sources: new Map([["clerk", review.sourceSha256!]]),
      hostedClients: new Set<string>(),
      metadata: new Map([[method.metadata, { document, sha256: catalogDocumentSha256(document) }]]),
    });
  assert.deepEqual(check(clerkMetadata), []);
  for (const document of [
    previous,
    ...[
      { issuer: "https://unreviewed.example" },
      { authorization_endpoint: "https://unreviewed.example/authorize" },
      { token_endpoint: "https://unreviewed.example/token" },
      { jwks_uri: "https://unreviewed.example/jwks.json" },
      { token_endpoint_auth_methods_supported: ["client_secret_basic"] },
      { code_challenge_methods_supported: ["plain"] },
      { grant_types_supported: ["client_credentials"] },
      { protected_resources: ["https://unreviewed.example"] },
      { scopes_supported: [...clerkMetadata.scopes_supported, "unreviewed:scope"] },
      { unreviewed_capability: true },
    ].map((change) => ({ ...clerkMetadata, ...change })),
  ]) {
    assert.deepEqual(check(document), [
      `clerk/oauth: automatic client metadata changed (metadataSha256: ${method.metadataSha256} -> ${catalogDocumentSha256(document)})`,
    ]);
  }
});
