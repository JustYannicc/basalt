import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthConsentScopesGrew } from "../../.upstream/packages/sdk/src/implementation/oauth-consent-targets.ts";

test("per-target consent accepts unchanged, reordered, duplicate and reduced scopes", () => {
  assert.equal(oauthConsentScopesGrew(["read", "write"], ["write", "read", "read"]), false);
  assert.equal(oauthConsentScopesGrew(["read", "write"], ["read"]), false);
  assert.equal(oauthConsentScopesGrew([], []), false);
});

test("retained provider identity cannot authorize a target's new scope", () => {
  assert.equal(oauthConsentScopesGrew(["read"], ["read", "new-access"]), true);
  assert.equal(oauthConsentScopesGrew([], ["read"]), true);
  assert.equal(oauthConsentScopesGrew(["read"], ["write"]), true);
});

test("a scope approved for another batch target does not expand this target's consent", () => {
  const primaryApproved = ["write", "new-access"];
  const additionalApproved = ["read"];
  assert.equal(oauthConsentScopesGrew(primaryApproved, ["write", "new-access"]), false);
  assert.equal(oauthConsentScopesGrew(additionalApproved, ["read", "new-access"]), true);
});
