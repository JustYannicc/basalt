import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-evidence.ts";
import { oauthFitness, oauthReviews } from "./oauth-policy.ts";
import type { Feed } from "./feed.ts";
import reviewData from "./oauth-reviews.json" with { type: "json" };
import clerkMetadata from "./clerk.oauth-metadata.json" with { type: "json" };

test("Clerk's reviewed resource list and sign-in scope still refuse metadata drift", () => {
  // Clerk added a protected-resource list and an advertised scope. Sign-in requests its own fixed
  // scope list, which doesn't include the new scope, so no new connection asks for more.
  const scope = "poppy:browser-sign-in";
  assert.ok(clerkMetadata.scopes_supported.includes(scope));
  assert.deepEqual(clerkMetadata.protected_resources, ["https://clerk.com"]);
  const { protected_resources: _added, ...rest } = clerkMetadata;
  const previous = { ...rest, scopes_supported: rest.scopes_supported.filter((s) => s !== scope) };
  assert.equal(
    catalogDocumentSha256(previous),
    "158ac5428a3f49d85e6c3ab790e0bba4c2d4b813f163c583477a3e954994f9d9",
  );
  const source = readFileSync(new URL("./clerk.json", import.meta.url), "utf8");
  assert.ok(source.includes(String.raw`scopes: [\"user:org:read\",\"applications:read\"`));
  assert.ok(!source.includes(scope));
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
        description: "Authentication",
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
      { protected_resources: ["https://unreviewed.example"] },
      { token_endpoint_auth_methods_supported: ["client_secret_basic"] },
      { code_challenge_methods_supported: ["plain"] },
      { grant_types_supported: ["client_credentials"] },
      { scopes_supported: [...clerkMetadata.scopes_supported, "unreviewed:scope"] },
      { unreviewed_capability: true },
    ].map((change) => ({ ...clerkMetadata, ...change })),
  ]) {
    assert.deepEqual(check(document), [
      `clerk/oauth: automatic client metadata changed (metadataSha256: ${method.metadataSha256} -> ${catalogDocumentSha256(document)})`,
    ]);
  }
});
