import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectionObservation,
  poolObservation,
  quietAt,
  type PoolFact,
} from "../../../recipes/common/conditions.ts";
import { emptyCheckpoint, remember } from "../../../recipes/common/types.ts";
import {
  availabilityObservation,
  errorSpikeObservation,
  runtimeObservation,
  serviceErrorsObservation,
} from "../../../recipes/operator/conditions.ts";

const now = Date.UTC(2026, 9, 30, 10);
function pool(at: number, a = 0.1, b = 0.1): PoolFact {
  return {
    at,
    owner: true,
    provider: "opaque-provider",
    accounts: [a, b].map((remaining, index) => ({
      id: `opaque-${index}`,
      state: "active",
      fresh: true,
      failed: false,
      windows: [
        { id: "short", remaining, observedAt: at, resetAt: at + 3600000 },
        { id: "weekly", remaining: 0.9, observedAt: at, resetAt: at + 86400000 },
      ],
    })),
  };
}
test("only definitive current checks ask the credential owner to act", () => {
  const fact = {
    id: "opaque-account",
    at: now,
    current: true,
    checkable: true,
    canManage: true,
    canReconnect: true,
    status: "credentials_rejected",
  };
  assert.equal(connectionObservation(fact).verdict, "action");
  for (const status of ["check_failed", "upstream_unavailable", "rate_limited", "unknown"])
    assert.equal(connectionObservation({ ...fact, status }).verdict, "unknown");
  assert.equal(connectionObservation({ ...fact, current: false }).verdict, "unknown");
  assert.equal(
    connectionObservation({ ...fact, canManage: false, canReconnect: false }).verdict,
    "unknown",
  );
  assert.equal(connectionObservation({ ...fact, status: "healthy" }).verdict, "healthy");
});
test("quota requires all accounts, all blocking windows and independent complete observations", () => {
  let state = emptyCheckpoint();
  state = remember(state, poolObservation(pool(now), state));
  assert.equal(state.open, false);
  const duplicate = pool(now + 300000);
  for (const account of duplicate.accounts)
    for (const window of account.windows) window.observedAt = now;
  state = remember(state, poolObservation(duplicate, state));
  assert.equal(state.observation.failures, 1);
  const partial = pool(now + 1800000);
  for (const window of partial.accounts[1]!.windows) window.observedAt = now;
  state = remember(state, poolObservation(partial, state));
  assert.equal(state.observation.failures, 1);
  const complete = pool(now + 1800000);
  state = remember(state, poolObservation(complete, state));
  assert.equal(state.open, true);
  assert.deepEqual(state, JSON.parse(JSON.stringify(state)));
  assert.equal(state.observation.code, "pool-low");
  const episode = state.episode;
  state = remember(state, poolObservation(pool(now + 3600000, 0, 0), state));
  assert.equal(state.observation.code, "pool-exhausted");
  assert.equal(state.episode, episode);
  state = remember(state, poolObservation(pool(now + 5400000, 0.5, 0.5), state));
  assert.equal(state.open, true);
  state = remember(state, poolObservation(pool(now + 7200000, 0.5, 0.5), state));
  assert.equal(state.open, false);
  assert.equal(poolObservation(pool(now, 0.05, 0.8)).verdict, "unknown");
});
test("stale, failed and non-owner reads cannot open or resolve a quota episode", () => {
  for (const change of [
    (value: PoolFact) => {
      value.owner = false;
    },
    (value: PoolFact) => {
      value.accounts[0]!.fresh = false;
    },
    (value: PoolFact) => {
      value.accounts[0]!.failed = true;
    },
    (value: PoolFact) => {
      value.accounts[0]!.state = "unavailable";
    },
    (value: PoolFact) => {
      value.accounts[0]!.windows[0]!.resetAt = now - 1;
    },
  ]) {
    const value = pool(now);
    change(value);
    assert.equal(poolObservation(value).verdict, "unknown");
  }
  const previous = { ...emptyCheckpoint(), open: true, episode: 1 };
  assert.equal(
    remember(previous, poolObservation({ ...pool(now, 0.9, 0.9), owner: false }, previous)).open,
    true,
  );
});
test("an established quota episode remains quiet on stale data, and access loss withdraws without claiming recovery", () => {
  let state = emptyCheckpoint();
  state = remember(state, poolObservation(pool(now), state));
  state = remember(state, poolObservation(pool(now + 1800000), state));
  assert.equal(state.open, true);
  const stale = pool(now + 2100000);
  stale.accounts[0]!.fresh = false;
  const observation = poolObservation(stale, state);
  assert.equal(observation.verdict, "unknown");
  assert.equal(remember(state, observation).open, true);
  const inaccessible = {
    ...observation,
    cursor: "access-removed",
    at: now + 2200000,
    verdict: "withdraw" as const,
    code: "access-removed",
  };
  assert.equal(remember(state, inaccessible).open, false);
  assert.equal(inaccessible.verdict, "withdraw");
});
test("quiet hours use the person's selected timezone and have no implicit default", () => {
  assert.equal(quietAt(now, null), false);
  assert.equal(
    quietAt(Date.UTC(2026, 0, 1, 23), { timezone: "UTC", startHour: 22, endHour: 8 }),
    true,
  );
  assert.equal(
    quietAt(Date.UTC(2026, 0, 1, 8), { timezone: "UTC", startHour: 22, endHour: 8 }),
    false,
  );
});
test("availability needs three failures and three recoveries", () => {
  let state = emptyCheckpoint();
  for (let i = 0; i < 3; i++)
    state = remember(state, availabilityObservation(now + i * 60000, "failed", state));
  assert.equal(state.open, true);
  for (let i = 3; i < 5; i++)
    state = remember(state, availabilityObservation(now + i * 60000, "healthy", state));
  assert.equal(state.open, true);
  state = remember(state, availabilityObservation(now + 5 * 60000, "healthy", state));
  assert.equal(state.open, false);
});
test("HTTP counts require five adjacent adequately sampled closed minutes", () => {
  const buckets = Array.from({ length: 5 }, (_, index) => ({
    start: now - (5 - index) * 60000,
    requests: 100,
    errors: 5,
  }));
  assert.equal(serviceErrorsObservation(now, buckets).verdict, "action");
  assert.equal(
    serviceErrorsObservation(
      now,
      buckets.map((bucket) => ({ ...bucket, requests: 19 })),
    ).verdict,
    "unknown",
  );
  assert.equal(serviceErrorsObservation(now, buckets.slice(1)).verdict, "unknown");
  assert.equal(
    serviceErrorsObservation(
      now,
      buckets.map((bucket) => ({ ...bucket, errors: 0 })),
    ).verdict,
    "healthy",
  );
});
test("runtime readiness cannot close a flap episode before thirty stable minutes", () => {
  let state = emptyCheckpoint();
  const boots = [now - 10 * 60000, now - 5 * 60000, now];
  state = remember(
    state,
    runtimeObservation(
      { at: now, boot: "third", ready: true, startedAt: now, unexpectedBoots: boots },
      state,
    ),
  );
  assert.equal(state.open, true);
  state = remember(
    state,
    runtimeObservation(
      { at: now + 20 * 60000, boot: "third", ready: true, startedAt: now, unexpectedBoots: boots },
      state,
    ),
  );
  assert.equal(state.open, true);
  state = remember(
    state,
    runtimeObservation(
      { at: now + 30 * 60000, boot: "third", ready: true, startedAt: now, unexpectedBoots: boots },
      state,
    ),
  );
  state = remember(
    state,
    runtimeObservation(
      { at: now + 31 * 60000, boot: "third", ready: true, startedAt: now, unexpectedBoots: boots },
      state,
    ),
  );
  assert.equal(state.open, false);
});
test("event spikes use event volume and retain a fifteen-minute recovery window", () => {
  let state = emptyCheckpoint();
  assert.equal(errorSpikeObservation(now, 19, null, state).verdict, "unknown");
  state = remember(state, errorSpikeObservation(now, 20, null, state));
  assert.equal(state.open, true);
  for (let i = 1; i < 4; i++)
    state = remember(state, errorSpikeObservation(now + i * 5 * 60000, 0, null, state));
  assert.equal(state.open, true);
  state = remember(state, errorSpikeObservation(now + 20 * 60000, 0, null, state));
  assert.equal(state.open, false);
});

test("a different failed release replaces the question and decline without waiting for recovery", () => {
  const failure = {
    cursor: "release:1:1:failure",
    decision: "release:1:1",
    at: now,
    sourceAt: now,
    verdict: "action" as const,
    code: "production-release-failed",
    failures: 0,
    successes: 0,
    since: now,
  };
  let state = remember(emptyCheckpoint(), failure);
  state = {
    ...state,
    declined: true,
    notified: "sent",
    receipt: "opaque-receipt",
    ownerRun: "run-a",
    question: { id: "question-a", app: "copy", reviewUrl: "/approvals", run: "run-a" },
  };
  const same = remember(state, { ...failure, cursor: "release:1:1:updated", at: now + 1 });
  assert.equal(same.episode, 1);
  assert.equal(same.declined, true);
  const replacement = remember(same, {
    ...failure,
    cursor: "release:2:1:failure",
    decision: "release:2:1",
    sourceAt: now + 2,
    at: now + 2,
  });
  assert.equal(replacement.episode, 2);
  assert.equal(replacement.declined, false);
  assert.equal(replacement.notified, "none");
  assert.equal(replacement.question, undefined);
  assert.equal(replacement.ownerRun, undefined);
  assert.equal(replacement.receipt, undefined);
});
