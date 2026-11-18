import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PoolReliability,
  PoolReliabilitySlo,
} from "../../apps/pool/reliability-contract.ts";
import { capturedReliability, recordReliability, reliabilityFreshMs } from "./reliability-cadence.ts";
import { reportingCadence } from "./reporting.ts";

const minute = 60_000;
const empty = { requests: 0, failed: 0, unassignedFailures: 0, successRate: null, failures: [] };
const window = (to: number): PoolReliability => ({
  from: new Date(to - minute).toISOString(),
  to: new Date(to).toISOString(),
  classification: "ready",
  real: empty,
  proof: empty,
});

function fixture() {
  const values = new Map<string, unknown>();
  const computedAt: number[] = [];
  const compute = async (now: number): Promise<PoolReliabilitySlo> => {
    computedAt.push(now);
    return { target: 99, state: "no_traffic", captureAt: null, hour: window(now), day: window(now) };
  };
  const storage = {
    get: async <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
    put: async (name: string, value: unknown) => {
      values.set(name, structuredClone(value));
    },
  };
  return { storage, compute, computedAt };
}

test("the minute check-in reuses each capture's figure: 12 computations an hour instead of 60", async () => {
  const f = fixture();
  const start = 1_000_000_000;
  for (let at = 0; at < 60 * minute; at += minute) {
    // Captures land a few seconds after their five-minute deadline.
    if (at % reportingCadence === 0)
      await recordReliability(f.storage, "pool", f.compute, start + at + 4_000);
    const figure = await capturedReliability(f.storage, "pool", f.compute, start + at + 30_000);
    const capturedAt = start + Math.floor(at / reportingCadence) * reportingCadence + 4_000;
    assert.equal(figure.hour.to, new Date(capturedAt).toISOString(), "the latest capture's windows");
  }
  assert.equal(f.computedAt.length, 12);
});

test("a stopped capture leaves the check-in computing once per freshness interval", async () => {
  const f = fixture();
  const start = 1_000_000_000;
  await recordReliability(f.storage, "pool", f.compute, start);
  for (let at = minute; at <= 30 * minute; at += minute)
    await capturedReliability(f.storage, "pool", f.compute, start + at);
  assert.deepEqual(
    f.computedAt.map((at) => at - start),
    [0, 1, 2, 3, 4, 5].map((count) => count * reliabilityFreshMs),
  );
});

test("a figure for another pool or from a clock ahead of this one is computed again", async () => {
  const f = fixture();
  await recordReliability(f.storage, "other", f.compute, 1_000);
  await capturedReliability(f.storage, "pool", f.compute, 2_000);
  await recordReliability(f.storage, "pool", f.compute, 10_000);
  await capturedReliability(f.storage, "pool", f.compute, 9_000);
  assert.deepEqual(f.computedAt, [1_000, 2_000, 10_000, 9_000]);
});

test("a failed computation records nothing, so the next check-in computes again", async () => {
  const f = fixture();
  await assert.rejects(
    capturedReliability(f.storage, "pool", async () => {
      throw new Error("history unavailable");
    }),
    /history unavailable/,
  );
  await capturedReliability(f.storage, "pool", f.compute, 5_000);
  assert.deepEqual(f.computedAt, [5_000]);
});
