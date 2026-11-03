import test from "node:test";
import assert from "node:assert/strict";
import type { AccountObservationResult } from "../.upstream/packages/apps/src/contracts/account-observation.ts";
import { freshObservation, freshnessMillis } from "../.upstream/packages/sdk/src/implementation/account-observation-state.ts";
import { publicQuotaObservation } from "../src/pool/quota-observation-public.ts";
import { quotaObservation } from "../src/pool/quota-observation.ts";

const observedAt = "2026-11-03T10:00:00.000Z";
const start = Date.parse(observedAt);
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const result = (staleAt?: string): AccountObservationResult => ({
  observedAt,
  observation: {
    offering: "subscription",
    plan: { label: "Pro", observedAt, ...(staleAt === undefined ? {} : { staleAt }) },
    windows: [{ id: "weekly", label: "Weekly", observedAt, ...(staleAt === undefined ? {} : { staleAt }), measure: { unit: "requests", remaining: 50 } }],
    balances: [{ id: "credits", label: "Credits", unit: "credits", available: 2, observedAt, ...(staleAt === undefined ? {} : { staleAt }) }],
  },
});

test("explicit source horizons replace the default, including the result timestamp", () => {
  const reading = result(at(35));
  assert.equal(freshObservation(reading, start + 25 * 60_000), true);
  assert.equal(freshObservation(reading, Date.parse(at(35)) - 1), true);
  assert.equal(freshObservation(reading, Date.parse(at(35))), false);
  assert.equal(freshObservation(result(at(2)), Date.parse(at(2))), false);
});

test("readings without a horizon and empty results retain the five-minute default", () => {
  for (const reading of [result(), { observedAt, observation: { offering: "unknown", windows: [], balances: [] } } satisfies AccountObservationResult]) {
    assert.equal(freshObservation(reading, start + freshnessMillis - 1), true);
    assert.equal(freshObservation(reading, start + freshnessMillis), false);
  }
  for (const kind of ["plan", "windows", "balances"] as const) {
    const reading = result(at(35));
    const mixed = { ...reading, observation: { ...reading.observation, [kind]: result().observation[kind] } };
    assert.equal(freshObservation(mixed, start + freshnessMillis), false, kind);
  }
});

test("window resets and balance expiry end freshness before the declared horizon", () => {
  for (const kind of ["reset", "expiry"] as const) {
    const reading = result(at(35));
    const bounded = { ...reading, observation: { ...reading.observation,
      ...(kind === "reset" ? { windows: [{ ...reading.observation.windows[0]!, resetsAt: at(10) }] }
        : { balances: [{ ...reading.observation.balances[0]!, expiresAt: at(10) }] }),
    } };
    assert.equal(freshObservation(bounded, Date.parse(at(10)) - 1), true);
    assert.equal(freshObservation(bounded, Date.parse(at(10))), false);
  }
});

test("future source times remain invalid even with explicit horizons", () => {
  const reading = result(at(35));
  assert.equal(freshObservation(reading, start - 60_001), false);
  assert.equal(freshObservation({ ...reading, observedAt: at(2) }, start), false);
});

test("the pool projection stays fresh between normal collections and eventually ages out", () => {
  const reading = publicQuotaObservation(quotaObservation({
    credential: { plan: { name: "Pro" } }, collection: { observed_at: observedAt },
    windows: [{ id: "weekly", unit: "requests", remaining: 50, observed_at: observedAt }],
    reset_credits: { available_count: 2, observed_at: observedAt, credits: [] },
  }));
  assert.ok(reading);
  assert.equal(freshObservation(reading, Date.parse(at(25))), true);
  assert.equal(freshObservation(reading, Date.parse(at(35))), true);
  assert.equal(freshObservation(reading, Date.parse(at(40))), false);
  assert.equal(freshObservation(reading, Date.parse(at(180))), false);
});
