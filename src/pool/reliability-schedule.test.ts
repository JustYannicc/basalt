import assert from "node:assert/strict";
import { test } from "node:test";
import { runAvailabilityProbe } from "./availability-schedule.ts";
import type { PoolReliability, PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";

const env = {
  POOL_AVAILABILITY_TARGET: "fixture-pool",
  SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
};
const window = (requests: number, failed: number): PoolReliability => ({
  from: "2026-11-12T02:00:00Z",
  to: "2026-11-12T03:00:00Z",
  classification: "ready",
  real: {
    requests,
    failed,
    unassignedFailures: 0,
    successRate: requests ? ((requests - failed) * 100) / requests : null,
    failures: [],
  },
  proof: {
    requests: 45,
    failed: 15,
    unassignedFailures: 0,
    successRate: (100 * 30) / 45,
    failures: [],
  },
});
const slo = (state: PoolReliabilitySlo["state"]): PoolReliabilitySlo => ({
  target: 99,
  state,
  captureAt: "2026-11-12T03:00:00Z",
  hour: window(100, 2),
  day: window(1000, 2),
});

for (const state of ["breached", "unavailable"] as const)
  test(`a ${state} SLO leaves healthy synthetic availability green`, async (t) => {
    const envelopes: { type: string; payload: Record<string, unknown> }[] = [];
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      const lines = new TextDecoder().decode(init.body as ArrayBuffer).split("\n");
      envelopes.push({ type: JSON.parse(lines[1]!).type, payload: JSON.parse(lines[2]!) });
      return new Response(null, { status: 202 });
    });
    t.mock.method(console, "error", () => {});
    await runAvailabilityProbe(
      env,
      async () => ({ ok: true, failures: [] }),
      async () => ({
        ...slo(state),
        ...(state === "unavailable" ? { reason: "capture_stale" as const } : {}),
      }),
    );
    assert.equal(envelopes.length, state === "breached" ? 3 : 2);
    const checks = envelopes
      .filter((entry) => entry.type === "check_in")
      .map((entry) => entry.payload);
    assert.deepEqual(
      checks.map((entry) => entry.monitor_slug),
      ["pool-availability", "pool-availability"],
    );
    assert.deepEqual(
      checks.map((entry) => entry.status),
      ["in_progress", "ok"],
    );
    assert.equal(checks[0]!.check_in_id, checks[1]!.check_in_id);
    let context: { hour: unknown; state: string };
    if (state === "breached") {
      const event = envelopes.find((entry) => entry.type === "event")!.payload;
      assert.equal(event.level, "error");
      assert.deepEqual(event.fingerprint, ["basalt", "pool_request_success_below_target"]);
      context = (event.contexts as { request_reliability: typeof context }).request_reliability;
      assert.deepEqual(diagnostics, []);
    } else {
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]![0], "POOL_REQUEST_RELIABILITY_UNKNOWN");
      assert.equal((diagnostics[0]![1] as { reason: string }).reason, "capture_stale");
      context = diagnostics[0]![1] as typeof context;
    }
    assert.equal(context.state, state);
    assert.deepEqual(context.hour, {
      requests: 100,
      failed: 2,
      proof_requests: 45,
      proof_failed: 15,
    });
    assert.doesNotMatch(
      JSON.stringify(envelopes),
      /fixture-pool|client_key|source_record|monitor_config/,
    );
  });

for (const state of ["breached", "unavailable"] as const)
  test(`a rejected availability RPC preserves the independently ${state} SLO`, async (t) => {
    const messages: Record<string, unknown>[] = [];
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      messages.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer).split("\n")[2]!));
      return new Response(null, { status: 202 });
    });
    t.mock.method(console, "error", () => {});
    await runAvailabilityProbe(
      env,
      async () => {
        throw new Error("private-runtime-error");
      },
      async () => slo(state),
    );
    const availability = messages.find(
      (message) =>
        message.message && String(message.message).startsWith("pool_availability_failure"),
    )!;
    assert.equal(availability.level, "error");
    assert.deepEqual(
      messages.filter((message) => message.status).map((message) => message.status),
      ["in_progress", "error"],
    );
    const event = messages.find(
      (message) => message.message && String(message.message).startsWith("pool_request_"),
    );
    if (state === "breached") {
      assert.equal(event!.level, "error");
      assert.deepEqual(event!.fingerprint, ["basalt", "pool_request_success_below_target"]);
      assert.deepEqual(diagnostics, []);
    } else {
      assert.equal(event, undefined);
      assert.equal(messages.filter((message) => message.fingerprint).length, 1);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]![0], "POOL_REQUEST_RELIABILITY_UNKNOWN");
    }
    const context = availability.contexts as {
      pool_probe: { failures: { guard: string; reason: string }[] };
    };
    assert.ok(context.pool_probe.failures.some((failure) => failure.guard === "runtime"));
    assert.ok(
      context.pool_probe.failures.some((failure) => failure.guard === "request_reliability"),
    );
    assert.doesNotMatch(JSON.stringify(messages), /private-runtime-error/);
  });

test("a failed collector logs a closed diagnostic without an issue and no-traffic stays unmeasured", async (t) => {
  const messages: Record<string, unknown>[] = [];
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    messages.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer).split("\n")[2]!));
    return new Response(null, { status: 202 });
  });
  t.mock.method(console, "error", () => {});
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => {
      throw new Error("private-connection-secret");
    },
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[1]!.status, "ok");
  assert.deepEqual(diagnostics, [
    [
      "POOL_REQUEST_RELIABILITY_UNKNOWN",
      { target: 99, state: "unavailable", reason: "collection_unavailable" },
    ],
  ]);
  assert.doesNotMatch(JSON.stringify([messages, diagnostics]), /private-connection-secret/);
  messages.length = 0;
  diagnostics.length = 0;
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => ({ ...slo("no_traffic"), hour: window(0, 0), day: window(0, 0) }),
  );
  assert.deepEqual(
    messages.map((message) => message.status),
    ["in_progress", "ok"],
  );
  assert.deepEqual(diagnostics, []);
});

test("pending classification reports unknown reliability without a monitor error", async (t) => {
  const messages: Record<string, unknown>[] = [];
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    messages.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer).split("\n")[2]!));
    return new Response(null, { status: 202 });
  });
  t.mock.method(console, "error", () => assert.fail("unknown SLO logged a pool outage"));
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => ({
      ...slo("unavailable"),
      reason: "classification_pending",
      hour: { ...window(0, 0), classification: "pending" },
      day: { ...window(0, 0), classification: "pending" },
    }),
  );
  assert.deepEqual(
    messages.map((message) => message.status),
    ["in_progress", "ok"],
  );
  assert.deepEqual(diagnostics, [
    [
      "POOL_REQUEST_RELIABILITY_UNKNOWN",
      {
        target: 99,
        state: "unavailable",
        reason: "classification_pending",
        hour: { requests: 0, failed: 0, proof_requests: 45, proof_failed: 15 },
        day: { requests: 0, failed: 0, proof_requests: 45, proof_failed: 15 },
      },
    ],
  ]);
});

test("unknown collection diagnostics exclude private fields and invalid counts", async (t) => {
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 202 }));
  const unknown = slo("unavailable");
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => ({
      ...unknown,
      captureAt: "private-capture",
      hour: {
        ...unknown.hour,
        from: "private-window",
        real: { ...unknown.hour.real, requests: -1, failed: Infinity },
        proof: { ...unknown.hour.proof, requests: Number.MAX_SAFE_INTEGER + 1, failed: NaN },
      },
    }),
  );
  const context = diagnostics[0]![1] as { hour: unknown; reason: string };
  assert.deepEqual(context.hour, {
    requests: null,
    failed: null,
    proof_requests: null,
    proof_failed: null,
  });
  assert.equal(context.reason, "collection_unavailable");
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-/);
});

for (const proofFailed of [0, 45])
  test(`an empty real-request window stays no-data with ${proofFailed} proof failures`, async (t) => {
    const messages: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      messages.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer).split("\n")[2]!));
      return new Response(null, { status: 202 });
    });
    const empty = window(0, 0);
    const requests = proofFailed ? 45 : 0;
    const noTraffic = {
      ...empty,
      proof: {
        ...empty.proof,
        requests,
        failed: proofFailed,
        successRate: requests ? 0 : null,
      },
    };
    await runAvailabilityProbe(
      env,
      async () => ({ ok: true, failures: [] }),
      async () => ({ ...slo("no_traffic"), hour: noTraffic, day: noTraffic }),
    );
    assert.deepEqual(
      messages.map((message) => message.status),
      ["in_progress", "ok"],
    );
  });
