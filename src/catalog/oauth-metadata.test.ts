import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-evidence.ts";
import { oauthFitness, oauthReviews } from "./oauth-policy.ts";
import reviewData from "./oauth-reviews.json" with { type: "json" };
import sentryMetadata from "./sentry.oauth-metadata.json" with { type: "json" };

test("Sentry's reviewed metadata admits account selection and still refuses document drift", () => {
  // Sentry toolkit #1971 added these advertised prompts without changing the OAuth authority.
  assert.deepEqual(sentryMetadata.prompt_values_supported, ["consent", "select_account"]);
  const review = oauthReviews(reviewData).find((item) => item.entry === "sentry")!;
  const method = review.methods.oauth!;
  assert.equal(method.kind, "automatic");
  if (method.kind !== "automatic") throw new Error("Sentry must use reviewed automatic metadata");
  const feed = {
    version: 1,
    apps: [
      {
        id: "sentry",
        package: review.package,
        name: "Sentry",
        description: "Error monitoring",
        auth: [{ method: "oauth", kind: "oauth2" }],
        icons: [],
        source: "apps/sentry.json",
      },
    ],
  };
  const check = (document: unknown) =>
    oauthFitness(feed, [review], {
      sources: new Map([["sentry", review.sourceSha256!]]),
      hostedClients: new Set<string>(),
      metadata: new Map([[method.metadata, { document, sha256: catalogDocumentSha256(document) }]]),
    });
  assert.deepEqual(check(sentryMetadata), []);
  for (const change of [
    { issuer: "https://unreviewed.example" },
    { authorization_endpoint: "https://unreviewed.example/authorize" },
    { scopes_supported: [...sentryMetadata.scopes_supported, "unreviewed:scope"] },
    { prompt_values_supported: ["consent", "select_account", "login"] },
  ]) {
    assert.deepEqual(check({ ...sentryMetadata, ...change }), [
      "sentry/oauth: automatic client metadata is missing or changed",
    ]);
  }
});
