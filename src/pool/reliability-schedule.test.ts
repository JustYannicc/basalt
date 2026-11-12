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
  test(`the existing monitor alerts separately for ${state} real-request reliability`, async (t) => {
    const envelopes: { type: string; payload: Record<string, unknown> }[] = [];
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
    assert.equal(envelopes.length, 3);
    const checks = envelopes
      .filter((entry) => entry.type === "check_in")
      .map((entry) => entry.payload);
    assert.deepEqual(
      checks.map((entry) => entry.monitor_slug),
      ["pool-availability", "pool-availability"],
    );
    assert.deepEqual(
      checks.map((entry) => entry.status),
      ["in_progress", "error"],
    );
    assert.equal(checks[0]!.check_in_id, checks[1]!.check_in_id);
    const event = envelopes.find((entry) => entry.type === "event")!.payload;
    assert.deepEqual(event.fingerprint, [
      "basalt",
      state === "breached"
        ? "pool_request_success_below_target"
        : "pool_request_collection_unavailable",
    ]);
    const context = event.contexts as { request_reliability: { hour: unknown } };
    assert.deepEqual(context.request_reliability.hour, {
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

test("a failed collector sends an unavailable alert and no-traffic does not claim a measured success rate", async (t) => {
  const messages: Record<string, unknown>[] = [];
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
  assert.deepEqual(messages.at(-1)!.fingerprint, ["basalt", "pool_request_collection_unavailable"]);
  assert.doesNotMatch(JSON.stringify(messages), /private-connection-secret/);
  messages.length = 0;
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => ({ ...slo("no_traffic"), hour: window(0, 0), day: window(0, 0) }),
  );
  assert.deepEqual(
    messages.map((message) => message.status),
    ["in_progress", "ok"],
  );
});
