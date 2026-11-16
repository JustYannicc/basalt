import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolReliability, PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";
import { runAvailabilityProbe } from "./availability-schedule.ts";
import { reliabilityState } from "./model-history/reliability-slo.ts";

const window = (requests: number, failed: number, proof = 0): PoolReliability => ({
  from: "2026-11-14T11:00:00Z",
  to: "2026-11-14T12:00:00Z",
  classification: "ready",
  real: {
    requests,
    failed,
    unassignedFailures: 0,
    successRate: requests ? ((requests - failed) * 100) / requests : null,
    failures: [],
  },
  proof: {
    requests: proof,
    failed: proof,
    unassignedFailures: 0,
    successRate: proof ? 0 : null,
    failures: [],
  },
});

const percentage = "pool_request_success_below_target";
const immediate = "pool_request_failing_now";

const cases = [
  {
    name: "1 in 9 remains a raw breach without a percentage notification",
    hour: window(9, 1),
    day: window(9, 1),
    current: window(1, 1),
    expected: [immediate],
  },
  {
    name: "2 in 100 with a recent failure notifies at the exact volume boundary",
    hour: window(100, 2),
    day: window(100, 2),
    current: window(1, 1),
    expected: [percentage, immediate],
  },
  {
    name: "99 requests remain below the notification floor",
    hour: window(99, 2),
    day: window(99, 2),
    current: window(1, 1),
    expected: [immediate],
  },
  {
    name: "a healthy high-volume day cannot qualify a low-volume breached hour",
    hour: window(9, 1),
    day: window(1000, 1),
    current: window(1, 1),
    expected: [immediate],
  },
  {
    name: "an idle hour with an old daily breach emits no percentage notification",
    hour: window(0, 0),
    day: window(100, 2),
    current: window(0, 0),
    expected: [],
  },
  {
    name: "recent successes do not keep an old percentage breach paging",
    hour: window(100, 2),
    day: window(100, 2),
    current: window(1, 0),
    expected: [],
  },
  {
    name: "the day window can qualify independently of a low-volume hour",
    hour: window(1, 1),
    day: window(100, 2),
    current: window(1, 1),
    expected: [percentage, immediate],
  },
  {
    name: "proof failures cannot establish recent real failures",
    hour: window(100, 2),
    day: window(100, 2),
    current: window(0, 0, 500),
    expected: [],
  },
  {
    name: "proof requests cannot satisfy the real-request volume floor",
    hour: window(9, 1, 500),
    day: window(9, 1, 500),
    current: window(1, 1),
    expected: [immediate],
  },
  {
    name: "a genuine current failure still notifies below a met percentage objective",
    hour: window(1000, 1),
    day: window(1000, 1),
    current: window(1, 1),
    expected: [immediate],
  },
];

for (const example of cases)
  test(example.name, async (t) => {
    const messages: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      messages.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer).split("\n")[2]!));
      return new Response(null, { status: 202 });
    });
    const measured: PoolReliabilitySlo = {
      target: 99,
      state: reliabilityState(example.hour, example.day),
      captureAt: "2026-11-14T12:00:00Z",
      hour: example.hour,
      day: example.day,
      current: example.current,
    };
    const before = structuredClone(measured);
    await runAvailabilityProbe(
      {
        POOL_AVAILABILITY_TARGET: "fixture-pool",
        SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
      },
      async () => ({ ok: true, failures: [] }),
      async () => measured,
    );
    assert.deepEqual(
      messages
        .filter((message) => message.fingerprint)
        .map((message) => (message.tags as { error_code: string }).error_code),
      example.expected,
    );
    assert.deepEqual(measured, before, "notification eligibility must not rewrite the raw SLI");
    assert.deepEqual(
      messages.filter((message) => message.status).map((message) => message.status),
      ["in_progress", "ok"],
    );
    if (example.hour.real.requests === 9 && example.hour.real.failed === 1) {
      assert.equal(measured.state, "breached");
      assert.equal(measured.hour.real.successRate, 800 / 9);
    }
  });

const captured = Date.parse("2026-11-14T12:00:00Z");
const unavailable = "pool_request_reliability_unavailable";
const collectionCases = [
  { reason: "capture_lagging", age: 299_999, expected: [] },
  { reason: "capture_lagging", age: 300_000, expected: [unavailable] },
  { reason: "capture_lagging", age: 300_001, expected: [unavailable] },
  { reason: "capture_lagging", age: -1, expected: [unavailable] },
  { reason: "capture_lagging", captureAt: null, expected: [unavailable] },
  { reason: "capture_lagging", captureAt: "invalid", expected: [unavailable] },
  { reason: "history_inactive", age: 1, expected: [unavailable] },
  { reason: "capture_stale", age: 1, expected: [unavailable] },
  { reason: "classification_pending", age: 1, expected: [unavailable] },
  { reason: "terminal_collection_pending", age: 1, expected: [unavailable] },
  { reason: "terminal_collection_unavailable", age: 1, expected: [unavailable] },
  { reason: "capture_lagging", age: 1, failed: true, expected: [immediate] },
] satisfies {
  reason: NonNullable<PoolReliabilitySlo["reason"]>;
  age?: number;
  captureAt?: string | null;
  failed?: boolean;
  expected: string[];
}[];

for (const example of collectionCases)
  test(`collection notifications preserve ${example.reason}, age=${example.age}, capture=${example.captureAt}, failed=${example.failed}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: captured });
    const messages: Record<string, unknown>[] = [];
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      messages.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer).split("\n")[2]!));
      return new Response(null, { status: 202 });
    });
    const measured: PoolReliabilitySlo = {
      target: 99,
      state: "unavailable",
      reason: example.reason,
      captureAt:
        example.age === undefined
          ? example.captureAt!
          : new Date(captured - example.age).toISOString(),
      hour: window(1, example.failed ? 1 : 0),
      day: window(1, example.failed ? 1 : 0),
      current: window(1, example.failed ? 1 : 0),
    };
    const before = structuredClone(measured);
    await runAvailabilityProbe(
      {
        POOL_AVAILABILITY_TARGET: "fixture-pool",
        SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
      },
      async () => ({ ok: true, failures: [] }),
      async () => measured,
    );
    assert.deepEqual(
      messages
        .filter((message) => message.fingerprint)
        .map((message) => (message.tags as { error_code: string }).error_code),
      example.expected,
    );
    assert.deepEqual(measured, before, "grace never changes the unknown objective or raw counts");
    assert.deepEqual(
      messages.filter((message) => message.status).map((message) => message.status),
      ["in_progress", "ok"],
    );
    assert.equal((diagnostics[0]![1] as { state: string }).state, "unavailable");
    assert.equal((diagnostics[0]![1] as { reason: string }).reason, example.reason);
  });
