import assert from "node:assert/strict";
import { test } from "node:test";
import { runAvailabilityProbe } from "./availability-schedule.ts";
import { capturePoolMonitor, startPoolMonitor } from "../telemetry/pool-monitor.ts";
import { availabilityCron } from "./availability-config.ts";

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

function assertNoPrivateDiagnostics(value: unknown) {
  if (typeof value === "number") assert.notEqual(value, 10000);
  else if (typeof value === "string") {
    assert.doesNotMatch(value, /private-/);
    // Match numeric tokens, including HTTP status text, without splitting decimals.
    for (const token of value.matchAll(
      /(?<![\w.])(?:HTTP)?[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?![\w.])/gi,
    ))
      assert.notEqual(Number(token[0].replace(/^HTTP/i, "")), 10000);
  } else if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateDiagnostics(item);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertNoPrivateDiagnostics(key);
      assertNoPrivateDiagnostics(item);
    }
  }
}

test("the privacy assertion accepts a duration containing the status sentinel digits", () => {
  for (const duration of [
    0.00014304100000001084,
    "0.00014304100000001084",
    10000.25,
    "duration 10000.25s",
  ]) {
    assertNoPrivateDiagnostics([{ payload: { duration } }]);
  }
});

test("the privacy assertion rejects private values and status sentinels in nested fields", () => {
  for (const value of [
    "private-target@private-host.invalid",
    "private-secret",
    10000,
    "HTTP 10000",
    "HTTP10000",
    "HTTP 10000.",
    "10000",
  ]) {
    for (const message of [
      { payload: { message: value } },
      { payload: { contexts: { extra: [{ unexpected: value }] } } },
      { payload: { [String(value)]: "otherwise safe" } },
    ]) {
      assert.throws(() => assertNoPrivateDiagnostics([message]), assert.AssertionError);
    }
  }
});

test("disabled monitoring opens no connection and invokes no probe", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("disabled monitoring sent a request");
  });
  await runAvailabilityProbe({}, async () => {
    assert.fail("disabled probe ran");
  });
});

test("healthy monitoring sends paired check-ins with one identity, the first defining the monitor", async (t) => {
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
  assert.deepEqual(messages[0]!.payload.monitor_config, {
    schedule: { type: "crontab", value: "* * * * *" },
    timezone: "UTC",
    checkin_margin: 1,
    max_runtime: 1,
    failure_issue_threshold: 3,
    recovery_threshold: 1,
  });
  assert.equal(messages[1]!.payload.monitor_config, undefined, "only the opening check-in upserts");
  assert.doesNotMatch(JSON.stringify(messages), /fixture-pool/);
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
  const receipt = await startPoolMonitor(env, availabilityCron);
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
  assertNoPrivateDiagnostics(messages);
  assert.match(event.message, /runtime:unknown/);
});

test("missing request reliability emits its own incident while availability remains healthy", async (t) => {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  const receipt = await startPoolMonitor(env, availabilityCron);
  await capturePoolMonitor(env, receipt, {
    ok: true,
    failures: [{ guard: "request_reliability", reason: "collection_unavailable" }],
  });
  assert.equal(
    messages.find((item) => item.type === "check_in" && item.payload.status !== "in_progress")
      ?.payload.status,
    "ok",
  );
  assert.equal(messages.filter((item) => item.type === "event").length, 1);
  assert.equal(
    messages.find((item) => item.type === "event")?.payload.tags.error_code,
    "pool_request_reliability_unavailable",
  );
  assertNoPrivateDiagnostics(messages);
});

test("pending traffic classification reports blindness without a failing-now page", async (t) => {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  const counts = { requests: 5, failed: 1, unassignedFailures: 1, successRate: 80, failures: [] };
  const pending = {
    from: "2026-11-13T00:00:00Z",
    to: "2026-11-14T00:00:00Z",
    classification: "pending" as const,
    real: counts,
    proof: { ...counts, requests: 0, failed: 0 },
  };
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => ({
      target: 99,
      state: "unavailable",
      reason: "classification_pending",
      captureAt: null,
      current: pending,
      hour: pending,
      day: pending,
    }),
  );
  const codes = messages
    .filter((item) => item.type === "event")
    .map((item) => item.payload.tags.error_code);
  assert.deepEqual(codes, ["pool_request_reliability_unavailable"]);
});

test("a failed reliability read logs its closed cause and still reports collection_unavailable", async (t) => {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => {
      throw new Error("Model request history is disabled");
    },
  );
  assert.deepEqual(
    errors.mock.calls
      .filter((call) => call.arguments[0] === "POOL_REQUEST_RELIABILITY_READ_FAILED")
      .map((call) => call.arguments[1]),
    [{ step: "session", failure: "history_disabled" }],
  );
  assert.match(
    messages.find((item) => item.type === "event")?.payload.message ?? "",
    /request_reliability:collection_unavailable/,
  );
});

test("unknown outcomes are logged every check-in, even when the objective is decided without them", async (t) => {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  const warnings = t.mock.method(console, "warn", () => {});
  const counts = {
    requests: 200,
    failed: 0,
    unassignedFailures: 0,
    successRate: 100,
    failures: [],
  };
  const window = (unknown: number) => ({
    from: "2026-11-18T11:00:00Z",
    to: "2026-11-18T12:00:00Z",
    classification: "ready" as const,
    real: counts,
    proof: { ...counts, requests: 0, successRate: null },
    unknown: {
      requests: unknown,
      pending: 0,
      unavailable: unknown,
      unmatched: 0,
      uncounted: unknown,
      couldFail: unknown,
    },
  });
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => ({
      target: 99,
      state: "ok",
      captureAt: null,
      current: window(0),
      hour: window(1),
      day: window(1),
    }),
  );
  const unknown = {
    requests: 1,
    pending: 0,
    unavailable: 1,
    unmatched: 0,
    uncounted: 1,
    could_fail: 1,
  };
  assert.deepEqual(
    warnings.mock.calls.map((call) => call.arguments),
    [["POOL_REQUEST_OUTCOMES_UNKNOWN", { state: "ok", hour: unknown, day: unknown }]],
  );
  assert.equal(
    messages.filter((item) => item.type === "event").length,
    0,
    "no page for a decided objective",
  );
  assertNoPrivateDiagnostics(messages);
});

test("an undecided objective pages collection_unavailable with the unknown counts in its context", async (t) => {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  t.mock.method(console, "warn", () => {});
  const counts = {
    requests: 150,
    failed: 1,
    unassignedFailures: 0,
    successRate: 99.3,
    failures: [],
  };
  const unknown = {
    requests: 1,
    pending: 0,
    unavailable: 1,
    unmatched: 0,
    uncounted: 0,
    couldFail: 1,
  };
  const window = {
    from: "2026-11-18T11:00:00Z",
    to: "2026-11-18T12:00:00Z",
    classification: "ready" as const,
    real: counts,
    proof: { ...counts, requests: 0, failed: 0, successRate: null },
    unknown,
  };
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => ({
      target: 99,
      state: "unavailable",
      reason: "terminal_collection_unavailable",
      captureAt: null,
      current: {
        ...window,
        real: { ...counts, failed: 0, successRate: 100 },
        unknown: { ...unknown, requests: 0, unavailable: 0 },
      },
      hour: window,
      day: window,
    }),
  );
  const events = messages.filter((item) => item.type === "event").map((item) => item.payload);
  assert.deepEqual(
    events.map((payload) => payload.tags.error_code),
    ["pool_request_reliability_unavailable"],
  );
  const [event] = events;
  assert.deepEqual(event?.contexts.request_reliability.hour.unknown, {
    requests: 1,
    pending: 0,
    unavailable: 1,
    unmatched: 0,
    uncounted: 0,
    could_fail: 1,
  });
  assert.equal(event?.contexts.request_reliability.reason, "terminal_collection_unavailable");
  assertNoPrivateDiagnostics(messages);
});
