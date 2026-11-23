import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PoolReliabilitySlo } from "../../apps/pool/reliability-contract.ts";
import { runAvailabilityProbe, type EpisodeMemory } from "./availability-schedule.ts";
import { capturePoolMonitor, startPoolMonitor } from "../telemetry/pool-monitor.ts";
import { availabilityCron } from "./availability-config.ts";
import { AvailabilityEpisodes } from "./availability-episode.ts";
import type { ProbeFailure, ProbeResult } from "./availability.ts";

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

/** A ready window of real requests, all succeeded, optionally with unknown outcomes. */
const quietWindow = (requests: number, couldFail?: number, uncounted = 0) => {
  const counts = { requests, failed: 0, unassignedFailures: 0, successRate: 100, failures: [] };
  return {
    from: "2026-11-18T11:00:00Z",
    to: "2026-11-18T12:00:00Z",
    classification: "ready" as const,
    real: counts,
    proof: { ...counts, requests: 0, successRate: null },
    ...(couldFail === undefined
      ? {}
      : {
          unknown: {
            requests: couldFail,
            pending: 0,
            unavailable: couldFail,
            unmatched: 0,
            uncounted,
            couldFail,
          },
        }),
  };
};

const undecidedBy = (hour: ReturnType<typeof quietWindow>, day: ReturnType<typeof quietWindow>) =>
  ({
    target: 99,
    state: "unavailable",
    reason: "terminal_collection_unavailable",
    captureAt: null,
    current: quietWindow(2, 0),
    hour,
    day,
  }) satisfies PoolReliabilitySlo;

async function collectionPages(t: TestContext, slo: PoolReliabilitySlo) {
  const messages: ReturnType<typeof unpack>[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    messages.push(unpack(init));
    return new Response(null, { status: 202 });
  });
  const warnings = t.mock.method(console, "warn", () => {});
  await runAvailabilityProbe(
    env,
    async () => ({ ok: true, failures: [] }),
    async () => slo,
  );
  return {
    pages: messages
      .filter((item) => item.type === "event")
      .map((item) => item.payload.tags.error_code),
    logged: warnings.mock.calls.map((call) => call.arguments[0]),
  };
}

test("a window too quiet to page is not paged as undecided, and its doubt is still logged", async (t) => {
  // One unknown outcome among 20 requests leaves the hour undecided; the day of 2,000 holds.
  const { pages, logged } = await collectionPages(t, {
    target: 99,
    state: "unavailable",
    reason: "terminal_collection_unavailable",
    captureAt: null,
    current: quietWindow(2, 0),
    hour: quietWindow(20, 1),
    day: quietWindow(2_000, 1),
  });
  assert.deepEqual(pages, []);
  assert.ok(logged.includes("POOL_REQUEST_OUTCOMES_UNKNOWN"));
});

test("a start still without a finish in a quiet hour is not paged as undecided either", async (t) => {
  const { pages } = await collectionPages(t, {
    ...undecidedBy(quietWindow(20, 1), quietWindow(2_000, 1)),
    reason: "terminal_collection_pending",
  });
  assert.deepEqual(pages, []);
});

for (const reason of [
  "history_inactive",
  "capture_stale",
  "capture_lagging",
  "classification_pending",
] as const)
  test(`${reason} is paged even while a quiet window is also undecided`, async (t) => {
    const { pages } = await collectionPages(t, {
      ...undecidedBy(quietWindow(20, 1), quietWindow(2_000, 1)),
      reason,
    });
    assert.deepEqual(pages, ["pool_request_reliability_unavailable"]);
  });

test("the floor counts the requests the doubt is about, not only those already counted", async (t) => {
  // 90 counted requests and 300 whose outcome no record establishes and which never reached Home:
  // 390 real requests.
  const { pages } = await collectionPages(
    t,
    undecidedBy(quietWindow(90, 300, 300), quietWindow(2_000, 0)),
  );
  assert.deepEqual(pages, ["pool_request_reliability_unavailable"]);
});

// Two possible failures leave a window of 99 or 100 clean requests undecided.
for (const [label, hour, day, paged] of [
  ["a quiet hour beside a busy undecided day", quietWindow(20, 1), quietWindow(150, 2), true],
  ["a decided hour beside a quiet undecided day", quietWindow(2_000, 1), quietWindow(20, 1), false],
  ["an undecided hour of 99 requests", quietWindow(99, 2), quietWindow(2_000, 2), false],
  ["an undecided hour of 100 requests", quietWindow(100, 2), quietWindow(2_000, 2), true],
] as const)
  test(`${label} is ${paged ? "" : "not "}paged as undecided`, async (t) => {
    const { pages } = await collectionPages(t, undecidedBy(hour, day));
    assert.deepEqual(pages, paged ? ["pool_request_reliability_unavailable"] : []);
  });

test("missing terminal evidence is paged however quiet the windows are", async (t) => {
  const { pages } = await collectionPages(t, {
    target: 99,
    state: "unavailable",
    reason: "terminal_collection_unavailable",
    captureAt: null,
    current: quietWindow(2),
    hour: quietWindow(20),
    day: quietWindow(40),
  });
  assert.deepEqual(pages, ["pool_request_reliability_unavailable"]);
});

test("a session failure the read already logged is not logged again by the check-in", async (t) => {
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
      // The figure's session runs elsewhere; only this message reaches the check-in.
      throw new Error("Model history reliability session failed");
    },
  );
  assert.deepEqual(
    errors.mock.calls.filter(
      (call) => call.arguments[0] === "POOL_REQUEST_RELIABILITY_READ_FAILED",
    ),
    [],
  );
  assert.match(
    messages.find((item) => item.type === "event")?.payload.message ?? "",
    /request_reliability:collection_unavailable/,
  );
});

function episodeFixture(t: TestContext) {
  const messages: ReturnType<typeof unpack>[] = [];
  let refused: "event" | "check_in" | undefined;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit | undefined) => {
    const message = unpack(init);
    messages.push(message);
    return new Response(null, { status: message.type === refused ? 429 : 202 });
  });
  t.mock.method(console, "error", () => {});
  const stored = new Map<string, unknown>();
  const memory = new AvailabilityEpisodes({
    get: async (key) => structuredClone(stored.get(key)),
    put: async (key, value) => void stored.set(key, structuredClone(value)),
  });
  const minute = async (
    failures: ProbeFailure[],
    options: { reliabilityFails?: boolean; episodes?: EpisodeMemory; pool?: string } = {},
  ) => {
    const before = messages.length;
    await runAvailabilityProbe(
      { ...env, POOL_AVAILABILITY_TARGET: options.pool ?? env.POOL_AVAILABILITY_TARGET },
      async (): Promise<ProbeResult> => ({ ok: failures.length === 0, failures }),
      options.reliabilityFails
        ? async (): Promise<PoolReliabilitySlo> => {
            throw new Error("history read failed");
          }
        : undefined,
      undefined,
      options.episodes ?? memory,
    ).catch(() => {});
    return messages
      .slice(before)
      .filter((item) => item.type === "event")
      .map((item) => item.payload.tags.error_code);
  };
  return { messages, minute, refuse: (type?: "event" | "check_in") => (refused = type) };
}
const overdue: ProbeFailure = { guard: "membership", reason: "renewal_overdue" };
const unavailable: ProbeFailure = { guard: "runtime", reason: "unavailable" };

test("a failure that continues is reported once, until a passing run ends its episode", async (t) => {
  const { messages, minute } = episodeFixture(t);
  assert.deepEqual(await minute([overdue]), ["pool_availability_failure"]);
  // The same failure a minute later is the same episode: 2 events a minute drained the quota.
  assert.deepEqual(await minute([overdue]), []);
  assert.deepEqual(await minute([]), []);
  assert.deepEqual(await minute([overdue]), ["pool_availability_failure"], "the pass ended it");
  assert.deepEqual(
    await minute([overdue, unavailable]),
    ["pool_availability_failure"],
    "a changed set of failures starts a new episode",
  );
  assert.equal(messages.filter((item) => item.payload.status === "error").length, 4);
});

test("a failing reliability reason is reported once, and again once it has stopped", async (t) => {
  const { minute } = episodeFixture(t);
  const reliable = ["pool_request_reliability_unavailable"];
  assert.deepEqual(await minute([], { reliabilityFails: true }), reliable);
  assert.deepEqual(await minute([], { reliabilityFails: true }), []);
  assert.deepEqual(await minute([]), []);
  assert.deepEqual(await minute([], { reliabilityFails: true }), reliable);
});

test("an episode start whose events Sentry refused is sent again the next minute", async (t) => {
  const { minute, refuse } = episodeFixture(t);
  refuse("event");
  assert.deepEqual(await minute([overdue], { reliabilityFails: true }), [
    "pool_availability_failure",
    "pool_request_reliability_unavailable",
  ]);
  refuse();
  assert.deepEqual(await minute([overdue], { reliabilityFails: true }), [
    "pool_availability_failure",
    "pool_request_reliability_unavailable",
  ]);
  assert.deepEqual(await minute([overdue], { reliabilityFails: true }), []);
});

test("a refused check-in alone does not send an accepted episode start again", async (t) => {
  const { minute, refuse } = episodeFixture(t);
  refuse("check_in");
  assert.deepEqual(await minute([overdue]), ["pool_availability_failure"]);
  assert.deepEqual(await minute([overdue]), []);
});

test("another pool's same failure is its own episode", async (t) => {
  const { minute } = episodeFixture(t);
  assert.deepEqual(await minute([overdue]), ["pool_availability_failure"]);
  assert.deepEqual(await minute([overdue], { pool: "other-pool" }), ["pool_availability_failure"]);
});

test("with its memory unreachable, a failing run reports on the quarter hour only", async (t) => {
  const { messages, minute } = episodeFixture(t);
  const unreachable: EpisodeMemory = {
    read: () => Promise.reject(new Error("pool object unavailable")),
    write: () => Promise.reject(new Error("pool object unavailable")),
  };
  let clock = Date.parse("2026-11-23T03:14:00Z");
  t.mock.method(Date, "now", () => clock);
  const reported: number[] = [];
  for (let i = 0; i < 31; i++, clock += 60_000)
    if ((await minute([unavailable], { episodes: unreachable })).length) reported.push(i);
  assert.deepEqual(reported, [1, 16], "03:15 and 03:30 only");
  assert.equal(messages.filter((item) => item.payload.status === "error").length, 31);
});
