import assert from "node:assert/strict";
import test from "node:test";
import source from "./cloudflare.json" with { type: "json" };
import metadata from "./cloudflare.oauth-metadata.json" with { type: "json" };
import reviewData from "./oauth-reviews.json" with { type: "json" };
import { cloudflareOAuthScopes } from "../pool/provider-accounts/cloudflare-scopes.ts";
import { handleCatalog } from "./worker.ts";
import { onServedFramework } from "./framework.ts";
import { catalogDocumentSha256 } from "../../scripts/catalog-oauth-evidence.ts";
import { oauthFitness, oauthReviews } from "./oauth-policy.ts";

const scopeFile = source.files.find((file) => file.path === "cloudflare-scopes.ts")!;

test("Cloudflare requests every reviewed issuer scope, including account token management", async () => {
  assert.equal(cloudflareOAuthScopes.length, 403);
  assert.equal(new Set(cloudflareOAuthScopes).size, cloudflareOAuthScopes.length);
  assert.deepEqual(cloudflareOAuthScopes, metadata.scopes_supported);
  for (const scope of [
    "account-api-tokens.write",
    "containers.read",
    "containers.write",
    "offline_access",
  ])
    assert.ok(
      cloudflareOAuthScopes.some((value) => value === scope),
      scope,
    );
  assert.ok(!metadata.scopes_supported.includes("user-api-tokens.write"));
  const index = source.files.find((file) => file.path === "index.ts")!.content;
  assert.ok(index.includes('import { cloudflareOAuthScopes } from "./cloudflare-scopes.ts"'));
  assert.ok(index.includes("oauth2({ discover: mcpUrl, scopes: [...cloudflareOAuthScopes] })"));
  const declared = JSON.parse(
    scopeFile.content.slice(scopeFile.content.indexOf("["), scopeFile.content.lastIndexOf("]") + 1),
  );
  assert.deepEqual(declared, metadata.scopes_supported);
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/cloudflare.json"),
    async () => {
      throw new Error("Cloudflare sign-in must use the reviewed source");
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), JSON.parse(onServedFramework(JSON.stringify(source))));
});

test("Cloudflare OAuth review binds automatic sign-in to the served full-scope source and metadata", () => {
  const review = oauthReviews(reviewData).find((item) => item.entry === "cloudflare")!;
  const decision = review.methods.oauth!;
  assert.equal(decision.kind, "automatic");
  if (decision.kind !== "automatic") return;
  assert.equal(decision.protocol, "cimd");
  const feed = {
    version: 1 as const,
    apps: [
      {
        id: "cloudflare",
        package: source.package,
        name: "Cloudflare",
        description: "Cloudflare",
        auth: [{ method: "oauth", kind: "oauth2" }],
        icons: [],
        source: "apps/cloudflare.json",
      },
    ],
  };
  const evidence = {
    sources: new Map([
      ["cloudflare", catalogDocumentSha256(JSON.parse(onServedFramework(JSON.stringify(source))))],
    ]),
    hostedClients: new Set<string>(),
    metadata: new Map([
      [decision.metadata, { sha256: catalogDocumentSha256(metadata), document: metadata }],
    ]),
  };
  assert.deepEqual(oauthFitness(feed, [review], evidence), []);
  const changed = {
    ...metadata,
    scopes_supported: metadata.scopes_supported.filter(
      (scope) => scope !== "account-api-tokens.write",
    ),
  };
  assert.deepEqual(
    oauthFitness(feed, [review], {
      ...evidence,
      metadata: new Map([
        [decision.metadata, { sha256: catalogDocumentSha256(changed), document: changed }],
      ]),
    }),
    [
      `cloudflare/oauth: automatic client metadata changed (metadataSha256: ${decision.metadataSha256} -> ${catalogDocumentSha256(changed)})`,
    ],
  );
});
