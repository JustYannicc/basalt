import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { AccountId } from "../../.upstream/packages/sdk/src/contracts/shared.ts";
import {
  OAuthRenewalFailed,
  OAuthReconnectRequired,
} from "../../.upstream/packages/sdk/src/contracts/oauth.ts";
import { accountCheckFailure } from "../../.upstream/packages/sdk/src/implementation/account-check-failure.ts";
import { AccountCheckFailure } from "../../.upstream/packages/sdk/src/contracts/account-check-failure.ts";

const account = AccountId.make("acc_synthetic");
test("renewal checks retain their bounded reason and protocol evidence", () => {
  for (const reason of [
    "service_unavailable",
    "rate_limited",
    "incompatible_response",
    "client_rejected",
    "renewal_rejected",
  ] as const) {
    const cause = { stage: "refresh", status: 400, providerError: "invalid_request" } as const;
    const error = new OAuthRenewalFailed({ account, reason, cause });
    assert.deepEqual(accountCheckFailure(error), {
      phase: "vendor",
      tag: "OAuthRenewalFailed",
      oauthRenewal: { reason, cause },
    });
  }
});
test("old health failures remain readable and arbitrary vendor data is excluded", () => {
  const decode = Schema.decodeUnknownSync(AccountCheckFailure);
  assert.deepEqual(decode({ phase: "vendor", tag: "OAuthRenewalFailed" }), {
    phase: "vendor",
    tag: "OAuthRenewalFailed",
  });
  const result = accountCheckFailure({
    _tag: "OAuthRenewalFailed",
    reason: "renewal_rejected",
    cause: {
      stage: "refresh",
      status: 400,
      providerError: "invalid_request",
      message: "synthetic-secret",
      url: "https://private.invalid",
    },
  });
  assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  assert.ok(!JSON.stringify(result).includes("private.invalid"));
  assert.deepEqual(result, {
    phase: "vendor",
    tag: "OAuthRenewalFailed",
    oauthRenewal: {
      reason: "renewal_rejected",
      cause: { stage: "refresh", status: 400, providerError: "invalid_request" },
    },
  });
});
test("reconnect-required checks retain invalid_grant evidence", () => {
  const cause = { stage: "refresh", status: 400, providerError: "invalid_grant" } as const;
  assert.deepEqual(accountCheckFailure(new OAuthReconnectRequired({ account, cause })), {
    phase: "vendor",
    tag: "OAuthReconnectRequired",
    oauthRenewal: { cause },
  });
});

test("an unusable cause does not erase a valid renewal reason", () => {
  assert.deepEqual(
    accountCheckFailure({
      _tag: "OAuthRenewalFailed",
      reason: "service_unavailable",
      cause: { stage: "refresh", providerError: "vendor_specific_private_value" },
    }),
    { phase: "vendor", tag: "OAuthRenewalFailed", oauthRenewal: { reason: "service_unavailable" } },
  );
});
