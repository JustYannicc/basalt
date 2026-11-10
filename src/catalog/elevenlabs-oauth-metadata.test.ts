import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-evidence.ts";
import { oauthFitness, oauthReviews } from "./oauth-policy.ts";
import type { Feed } from "./feed.ts";
import reviewData from "./oauth-reviews.json" with { type: "json" };
import elevenlabsMetadata from "./elevenlabs.oauth-metadata.json" with { type: "json" };

test("ElevenLabs's reviewed advertising-write scope still refuses metadata drift", () => {
  // The provider added only ads_write; endpoint, auth, PKCE and grant settings did not change.
  assert.ok(elevenlabsMetadata.scopes_supported.includes("ads_write"));
  const previous = {
    ...elevenlabsMetadata,
    scopes_supported: elevenlabsMetadata.scopes_supported.filter((scope) => scope !== "ads_write"),
  };
  assert.equal(
    catalogDocumentSha256(previous),
    "2a74d8ace0c536cbe0af7f7dd67b7b9e6e529803b57d868c44e3e21c7d8f5f76",
  );
  const review = oauthReviews(reviewData).find((item) => item.entry === "elevenlabs")!;
  const method = review.methods.oauth!;
  assert.equal(method.kind, "automatic");
  if (method.kind !== "automatic")
    throw new Error("ElevenLabs must use reviewed automatic metadata");
  assert.equal(
    method.metadata,
    "https://api.us.elevenlabs.io/.well-known/oauth-authorization-server",
  );
  const feed: Feed = {
    version: 1,
    apps: [
      {
        id: "elevenlabs",
        package: review.package,
        name: "ElevenLabs",
        description: "AI audio",
        auth: [{ method: "oauth", kind: "oauth2" }],
        icons: [],
        source: "apps/elevenlabs.json",
      },
    ],
  };
  const check = (document: unknown) =>
    oauthFitness(feed, [review], {
      sources: new Map([["elevenlabs", review.sourceSha256!]]),
      hostedClients: new Set<string>(),
      metadata: new Map([[method.metadata, { document, sha256: catalogDocumentSha256(document) }]]),
    });
  assert.deepEqual(check(elevenlabsMetadata), []);
  for (const document of [
    previous,
    ...[
      { issuer: "https://unreviewed.example" },
      { authorization_endpoint: "https://unreviewed.example/authorize" },
      { token_endpoint: "https://unreviewed.example/token" },
      { token_endpoint_auth_methods_supported: ["client_secret_basic"] },
      { code_challenge_methods_supported: ["plain"] },
      { grant_types_supported: ["client_credentials"] },
      { scopes_supported: [...elevenlabsMetadata.scopes_supported, "unreviewed:scope"] },
      { unreviewed_capability: true },
    ].map((change) => ({ ...elevenlabsMetadata, ...change })),
  ]) {
    assert.deepEqual(check(document), [
      "elevenlabs/oauth: automatic client metadata is missing or changed",
    ]);
  }
});
