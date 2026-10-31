import assert from "node:assert/strict";
import { test } from "node:test";
import { poolAccountsObservation } from "../../../recipes/pool-owner/account-condition.ts";
import type { PoolFact } from "../../../recipes/common/conditions.ts";
import { emptyCheckpoint, remember } from "../../../recipes/common/types.ts";

const now = Date.UTC(2026, 9, 31, 12);
function fact(at = now): PoolFact {
  return {
    at,
    owner: true,
    provider: "service",
    removals: { since: null, items: [] },
    accounts: [
      {
        id: "account-a",
        state: "active",
        fresh: true,
        failed: false,
        observedAt: at,
        collection: { status: "success", errorCode: null, attemptedAt: at },
        windows: [{ id: "short", remaining: 0.5, observedAt: at, resetAt: at + 3600000 }],
      },
    ],
  };
}
const baseline = () => remember(emptyCheckpoint(), poolAccountsObservation(fact()));
const absent = (at = now + 1000) => ({ ...fact(at), accounts: [] });

test("authoritative removal needs measured capacity impairment and persists until replacement", () => {
  const prior = baseline();
  const gone = poolAccountsObservation(absent(), prior);
  assert.equal(gone.verdict, "action");
  assert.equal(gone.code, "pool-account-no-longer-available");
  const open = remember(prior, gone);
  assert.equal(poolAccountsObservation(absent(now + 2000), open).verdict, "action");
  const replacement = fact(now + 3000);
  replacement.accounts[0]!.id = "account-b";
  assert.equal(poolAccountsObservation(replacement, open).verdict, "healthy");
  const stale = fact(now + 3000);
  stale.accounts[0]!.id = "account-b";
  stale.accounts[0]!.fresh = false;
  const uncertain = poolAccountsObservation(stale, prior);
  assert.equal(uncertain.verdict, "unknown");
  assert.equal(uncertain.readComplete, false);
  const waiting = remember(prior, uncertain);
  assert.equal(waiting.observation.poolMissing?.[0]?.id, "account-a");
  const blocked = fact(now + 4000);
  blocked.accounts[0]!.id = "account-b";
  blocked.accounts[0]!.windows[0]!.remaining = 0;
  assert.equal(poolAccountsObservation(blocked, waiting).verdict, "action");
  assert.equal(poolAccountsObservation(blocked, waiting).code, "pool-account-no-longer-available");
});

test("native intentional removals are quiet; absent or truncated history cannot prove unexpected loss", () => {
  const prior = baseline();
  const intentional = absent();
  intentional.removals!.items = [{ id: "account-a", at: now + 500 }];
  assert.equal(poolAccountsObservation(intentional, prior).verdict, "healthy");
  const unknown = absent();
  delete unknown.removals;
  assert.equal(poolAccountsObservation(unknown, prior).verdict, "unknown");
  const truncated = absent();
  truncated.removals!.since = now;
  assert.equal(poolAccountsObservation(truncated, prior).verdict, "unknown");
  const oldIntent = absent();
  oldIntent.removals!.items = [{ id: "account-a", at: now - 1 }];
  assert.equal(poolAccountsObservation(oldIntent, prior).verdict, "action");
});

test("a later owner acknowledgement withdraws an existing missing-account question", () => {
  const prior = baseline();
  const open = remember(prior, poolAccountsObservation(absent(), prior));
  const acknowledged = absent(now + 2000);
  acknowledged.removals!.items = [{ id: "account-a", at: now + 1500 }];
  assert.equal(poolAccountsObservation(acknowledged, open).verdict, "withdraw");
});

function rejected(at: number) {
  const value = fact(at);
  value.accounts[0]!.failed = true;
  value.accounts[0]!.collection = {
    status: "failed",
    errorCode: "UPSTREAM_AUTH_REJECTED",
    attemptedAt: at,
  };
  return value;
}
test("persistent account checks need three distinct attempts across thirty minutes", () => {
  let state = baseline();
  const first = rejected(now + 1);
  const confirmation = poolAccountsObservation(first, state);
  assert.equal(confirmation.readComplete, true);
  state = remember(state, confirmation);
  const cached = { ...first, at: now + 300000 };
  assert.equal(poolAccountsObservation(cached, state).poolChecks![0]!.count, 1);
  state = remember(state, poolAccountsObservation(rejected(now + 15 * 60000), state));
  assert.equal(poolAccountsObservation(rejected(now + 29 * 60000), state).verdict, "unknown");
  const third = poolAccountsObservation(rejected(now + 31 * 60000), state);
  assert.equal(third.verdict, "action");
  assert.equal(third.poolChecks![0]!.count, 3);
  state = remember(state, third);
  const limited = rejected(now + 32 * 60000);
  limited.accounts[0]!.collection!.errorCode = "UPSTREAM_RATE_LIMITED";
  assert.equal(poolAccountsObservation(limited, state).verdict, "unknown");
  assert.equal(poolAccountsObservation(limited, state).readComplete, false);
  assert.equal(poolAccountsObservation(fact(now + 33 * 60000), state).verdict, "healthy");
});

test("old or future failed readings cannot advance or reassert a failed-check decision", () => {
  let state = baseline();
  state = remember(state, poolAccountsObservation(rejected(now + 15 * 60000), state));
  const old = rejected(now + 1);
  old.at = now + 16 * 60000;
  const observed = poolAccountsObservation(old, state);
  assert.equal(observed.verdict, "unknown");
  assert.equal(observed.poolChecks![0]!.count, 1);
  const future = rejected(now + 20 * 60000);
  future.at = now + 16 * 60000;
  assert.equal(poolAccountsObservation(future, state).verdict, "unknown");
});

test("a cached success may finish after its attempt; older success cannot erase a newer failure", () => {
  const completed = fact(now + 100);
  completed.accounts[0]!.observedAt = now + 90;
  completed.accounts[0]!.collection!.attemptedAt = now;
  let state = remember(emptyCheckpoint(), poolAccountsObservation(completed));
  const cached = { ...completed, at: now + 200 };
  const reread = poolAccountsObservation(cached, state);
  assert.equal(reread.verdict, "healthy");
  assert.equal(reread.readComplete, true);
  state = remember(state, poolAccountsObservation(rejected(now + 15 * 60000), state));
  const oldSuccess = { ...completed, at: now + 16 * 60000 };
  const ignored = poolAccountsObservation(oldSuccess, state);
  assert.equal(ignored.verdict, "unknown");
  assert.equal(ignored.poolChecks![0]!.count, 1);
});
