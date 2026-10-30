import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { proveZendeskOAuth } from "./zendesk-oauth.mjs";
import { proveZendeskMcp } from "./zendesk-native.mjs";

/** Full catalog-served two-site proof over the native hosted HTTP/MCP runtime. */
export function proveZendeskNative({
  Effect, request, checked, actors, directory, prefix, callback, candidateSha, upstreamPin, carriedPatches,
  target, root, upstream, fixtures, catalog, step,
}) {
  return Effect.gen(function* () {
    const record = (stage, fields = {}) => appendFileSync(join(directory, "zendesk-proof.jsonl"),
      `${JSON.stringify({ candidateSha, upstreamPin, carriedPatches, stage, ...fields })}\n`, { mode: 0o600 });
    assert.equal(catalog.source.package, "zendesk");
    assert.equal(catalog.provenance.operatorMetadataInjectionVerified, true);
    assert.equal(fixtures.sites.length, 2);
    const { users, flowByKey } = yield* proveZendeskOAuth({
      Effect, request, checked, actors, prefix, callback, fixtures, catalog, record,
    });
    const nativeProof = yield* proveZendeskMcp({
      Effect, request, checked, actors, directory, prefix, target, root, upstream, fixtures, catalog, users, flowByKey, record, step,
    });
    const observations = fixtures.observations();
    const rotations = fixtures.rotations();
    const expectedFlows = [
      ["site-a", "public"], ["site-a", "confidential"], ["site-b", "public"], ["site-b", "confidential"],
      ["site-a", "hosted"], ["site-b", "hosted"],
    ];
    for (const [siteId, mode] of expectedFlows) {
      assert.ok(rotations.some((flow) => flow.site === siteId && flow.mode === mode && flow.rotated),
        `Expected access and refresh token rotation for ${siteId} ${mode}`);
    }
    assert.deepEqual(fixtures.failures(), [], "Zendesk external fixtures rejected a native runtime request");
    for (const event of observations.filter((entry) => entry.phase === "api")) {
      if (!event.bearerPresent) continue;
      assert.equal(event.credentialSiteMatches, true, "Credentials must stay at the account's exact site");
      assert.equal(event.marketplaceHeadersMatched, true, "Operator Marketplace headers must reach every API endpoint");
    }
    for (const site of fixtures.sites) {
      const hosted = observations.filter((event) => event.flowMode === "hosted" && event.site === site.id);
      assert.ok(hosted.some((event) => event.phase === "token_exchange" && event.authMethod === "client_secret_post"),
        `The synthetic host-owned client must exchange its code at ${site.id}`);
      assert.ok(hosted.some((event) => event.phase === "token_refresh" && event.authMethod === "client_secret_post" && event.rotated),
        `The synthetic host-owned client must rotate at ${site.id}`);
      assert.ok(hosted.some((event) => event.phase === "api" && event.endpoint === "/api/v2/users/me.json" && event.credentialSiteMatches),
        `Hosted health and tools must send only ${site.id}'s token to ${site.id}`);
      assert.ok(hosted.some((event) => event.phase === "api" && event.endpoint === "/api/v2/tickets.json" && event.credentialSiteMatches),
        `The hosted catalog ticket tool must read only ${site.id}`);
    }
    assert.equal(observations.some((event) =>
      event.phase === "api" && event.flowMode === "hosted" && event.tokenActive && !event.credentialSiteMatches,
    ), false, "A managed Zendesk token must never be active at a peer host");
    assert.ok(observations.some((event) => event.phase === "token_refresh" && event.site === "site-a" && event.authMethod === "none"));
    assert.ok(observations.some((event) => event.phase === "token_refresh" && event.site === "site-a" && event.authMethod === "client_secret_post"));
    assert.ok(observations.some((event) => event.phase === "token_refresh" && event.site === "site-b" && event.authMethod === "none"));
    assert.ok(observations.some((event) => event.phase === "token_refresh" && event.site === "site-b" && event.authMethod === "client_secret_post"));
    yield* Effect.promise(() => writeFile(join(directory, "zendesk-native-observations.json"), `${JSON.stringify({
      events: observations,
      rotations: rotations.map(({ site, mode, generation, rotated }) => ({ site, mode, generation, rotated })),
      failures: fixtures.failures(),
    }, null, 2)}\n`, { mode: 0o600 }));
    const report = {
      checks: nativeProof.installedAgentNativeToolCall ? 100 : 99,
      zendeskNativeAuthorizationStart: true,
      storedPublicClientSelectedAtBothSites: true,
      confidentialByoSelectedAtBothSites: true,
      zendeskPeerConnectionDenials: 2,
      zendeskPeerSiteClientDenials: 2,
      zendeskCrossSiteCallbackDenied: true,
      zendeskSiteRetargetDenied: true,
      zendeskCredentialPlacementBySite: true,
      zendeskTokenRotationForStoredAndByoFlows: true,
      zendeskToolReadAndHealthBySite: true,
      syntheticHostedClientDefinition: true,
      hostedManagedClientAtExactAccountSite: true,
      hostedManagedClientRotationAtExactAccountSite: true,
      hostedManagedClientPeerHostPlacementDenied: true,
      zendeskTicketCreateApprovalPreserved: true,
      ...nativeProof,
      hostedZendeskClientRegistrationProven: false,
      liveZendeskConsentProven: false,
    };
    record("native-proof-complete", report);
    step("zendesk-native-two-site-proof-passed");
    return report;
  });
}
