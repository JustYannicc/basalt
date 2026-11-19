import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  automaticDecisions,
  catalogDocumentSha256,
  committedOAuthMetadata,
} from "../../scripts/catalog-oauth-metadata.ts";
import { oauthPinProblems, oauthReviews } from "./oauth-policy.ts";
import reviewData from "./oauth-reviews.json" with { type: "json" };

// Mutations use values no publisher serves, so the proof survives every reviewed re-pin.
const changes = (document: Record<string, unknown>) => [
  { issuer: "https://unreviewed.example" },
  { authorization_endpoint: "https://unreviewed.example/authorize" },
  { token_endpoint: "https://unreviewed.example/token" },
  { registration_endpoint: "https://unreviewed.example/register" },
  {
    scopes_supported: [
      ...(Array.isArray(document.scopes_supported) ? document.scopes_supported : []),
      "unreviewed:scope",
    ],
  },
  { token_endpoint_auth_methods_supported: ["unreviewed_method"] },
  { code_challenge_methods_supported: ["plain"] },
  { grant_types_supported: ["urn:example:unreviewed-grant"] },
  { unreviewed_capability: true },
];

test("every reviewed metadata snapshot verifies and any unreviewed document change is refused", () => {
  const reviews = oauthReviews(reviewData);
  const committed = committedOAuthMetadata(reviews, fileURLToPath(new URL(".", import.meta.url)));
  const decisions = automaticDecisions(reviews);
  assert.ok(decisions.length > 0);
  for (const decision of decisions) {
    const label = `${decision.entry}/${decision.method}`;
    const document = committed.metadata.get(decision.metadata)?.document;
    assert.ok(typeof document === "object" && document !== null, label);
    const check = (candidate: unknown) =>
      oauthPinProblems([{ entry: decision.entry, methods: { [decision.method]: decision } }], {
        hostedClients: new Set(),
        metadata: new Map([
          [decision.metadata, { sha256: catalogDocumentSha256(candidate), document: candidate }],
        ]),
      });
    assert.deepEqual(check(document), [], label);
    const { token_endpoint: _removed, ...withoutToken } = document as Record<string, unknown>;
    for (const changed of [
      withoutToken,
      ...changes(document as Record<string, unknown>).map((change) => ({ ...document, ...change })),
    ])
      assert.deepEqual(check(changed), [
        `${label}: automatic client metadata changed (metadataSha256: ${decision.metadataSha256} -> ${catalogDocumentSha256(changed)})`,
      ]);
  }
});
