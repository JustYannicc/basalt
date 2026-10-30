import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account } from "./contract.ts";
import { subscriptionFailure } from "./account-health.ts";

const now = Date.parse("2030-01-01T00:00:00Z");
const account: Account = {
  id: "a", provider: "codex", label: "synthetic", plan: "Plus", state: "active", message: null,
  observedAt: new Date(now).toISOString(), freshness: "fresh", readingFailed: false,
  windows: [], nextReadAt: null, earliestResetAt: null, bankedResets: null,
  collection: { status: "success", errorCode: null, lastAttemptAt: new Date(now).toISOString() },
};

test("a successful credential read stays healthy when routing is paused or quota is exhausted", () => {
  assert.equal(subscriptionFailure({ ...account, state: "disabled" }, now), null);
  assert.equal(subscriptionFailure({ ...account, state: "unavailable", windows: [{ id: "week", label: "Weekly",
    remainingRatio: 0, resetAt: null, windowSeconds: 604800, observedAt: new Date(now).toISOString() }] }, now), null);
});

test("stale, absent, collecting and failed observations never report a healthy check", () => {
  for (const changed of [{ freshness: "stale" }, { observedAt: null }, { readingFailed: true },
    { collection: undefined }, { collection: { ...account.collection!, status: "collecting" } }] as const)
    assert.equal(subscriptionFailure({ ...account, ...changed }, now), "unavailable");
  assert.equal(subscriptionFailure(account, now + 30 * 60_000), "unavailable");
});

test("Home's documented errors choose the host's actual recovery reasons", () => {
  for (const [errorCode, reason] of [["UPSTREAM_AUTH_REJECTED", "unauthorized"], ["AUTH_TOKEN_UNAVAILABLE", "unauthorized"],
    ["UPSTREAM_RATE_LIMITED", "rate_limited"], ["UPSTREAM_UNAVAILABLE", "unavailable"], ["PROVIDER_UNAVAILABLE", "unavailable"],
    ["AUTH_RESOLVE_FAILED", "unavailable"], ["UNKNOWN", "unavailable"]])
    assert.equal(subscriptionFailure({ ...account, collection: { ...account.collection!, errorCode: errorCode! } }, now), reason);
});
