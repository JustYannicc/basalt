import assert from "node:assert/strict";
import { test } from "node:test";
import { runAvailabilityProbe } from "./availability-schedule.ts";
import { capturePoolMonitor, startPoolMonitor } from "../telemetry/pool-monitor.ts";

const env = {
  POOL_AVAILABILITY_TARGET: "fixture-pool",
  SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
};
function unpack(init: RequestInit | undefined) {
  const lines = new TextDecoder().decode(init?.body as ArrayBuffer).split("\n");
  const item = JSON.parse(lines[1]!);
  assert.equal(item.length, new TextEncoder().encode(lines[2]!).length);
  return { type: item.type, payload: JSON.parse(lines[2]!) };
}

test("disabled monitoring opens no connection and invokes no probe", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("disabled monitoring sent a request");
  });
  await runAvailabilityProbe({}, async () => {
    assert.fail("disabled probe ran");
  });
});

test("healthy monitoring sends paired check-ins with one identity and no monitor upsert", async (t) => {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  await runAvailabilityProbe(env, async (pool) => {
    assert.equal(pool, "fixture-pool");
    return { ok: true, failures: [] };
  });
  assert.deepEqual(
    messages.map((message) => [message.type, message.payload.status]),
    [
      ["check_in", "in_progress"],
      ["check_in", "ok"],
    ],
  );
  assert.equal(messages[0]!.payload.check_in_id, messages[1]!.payload.check_in_id);
  assert.equal(messages[0]!.payload.monitor_slug, "pool-availability");
  assert.doesNotMatch(JSON.stringify(messages), /monitor_config|fixture-pool/);
});

test("the first rejected installation produces an error check-in and fixed guard/reason evidence", async (t) => {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  await runAvailabilityProbe(env, async () => ({
    ok: false,
    failures: [{ guard: "native_policy_install", reason: "response_status", backendStatus: 400 }],
  }));
  assert.deepEqual(
    messages.map((message) => message.payload.status ?? message.type),
    ["in_progress", "error", "event"],
  );
  const event = messages.find((message) => message.type === "event")!.payload;
  assert.equal(event.tags.guard, "native_policy_install");
  assert.equal(event.tags.reason, "response_status");
  assert.match(event.message, /native_policy_install:response_status:HTTP400/);
  assert.deepEqual(event.contexts.pool_probe.failures, [
    { guard: "native_policy_install", reason: "response_status", backend_status: 400 },
  ]);
  assert.equal(messages[0]!.payload.check_in_id, messages[1]!.payload.check_in_id);
});

test("a failed RPC is reported without its private exception or target", async (t) => {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  await runAvailabilityProbe(env, async () => {
    throw new Error("private-token-private-host");
  });
  assert.equal(messages[1]!.payload.status, "error");
  assert.doesNotMatch(JSON.stringify(messages), /private-token|private-host|fixture-pool/);
});

test("alert delivery refusal fails the scheduled run even when the pool is healthy", async (t) => {
  let probes = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await assert.rejects(
    runAvailabilityProbe(env, async () => {
      probes++;
      return { ok: true, failures: [] };
    }),
    /alert delivery failed/,
  );
  assert.equal(probes, 1);
});

test("monitor error text and fields reject unbounded or private diagnostic input", async (t) => {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  const receipt = await startPoolMonitor(env);
  await capturePoolMonitor(env, receipt, {
    ok: false,
    failures: Array.from({ length: 20 }, () => ({
      guard: "private-target@private-host.invalid",
      reason: "private-secret",
      backendStatus: 10000,
    })),
  });
  const event = messages.find((message) => message.type === "event")!.payload;
  assert.equal(event.contexts.pool_probe.failures.length, 8);
  assert.equal(event.contexts.pool_probe.check_in_id, receipt.id);
  assert.doesNotMatch(JSON.stringify(messages), /private-|10000/);
  assert.match(event.message, /runtime:unknown/);
});
