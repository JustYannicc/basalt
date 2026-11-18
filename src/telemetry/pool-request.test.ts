import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { poolRequestEvent, type PoolRequestInput } from "./pool-request.ts";

const env = {
  SENTRY_DSN: "https://fixture_public_key@o0.ingest.de.sentry.io/1",
  SENTRY_OTLP_ENDPOINT: "https://o0.ingest.de.sentry.io/api/1/integration/otlp/v1/traces",
};
const requestId = "2f0c1d1e-7a55-4c7b-9d7e-0f3a5a1b2c3d";

/** A controllable clock, and the two places the event leaves by. */
function harness(context: TestContext, input: Partial<PoolRequestInput> = {}, target = env) {
  const logged: Record<string, unknown>[] = [];
  context.mock.method(console, "info", (value: Record<string, unknown>) => {
    logged.push({ ...value });
  });
  const sent: { url: string; redirect: RequestRedirect | undefined; body: string }[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), redirect: init?.redirect, body: String(init?.body) });
      return new Response(null, { status: 200 });
    },
  );
  let now = 1_000;
  const work: Promise<unknown>[] = [];
  const event = poolRequestEvent(
    target,
    {
      requestId,
      method: "POST",
      route: "/v1/chat/completions",
      kind: "model",
      port: 8317,
      inFlight: 4,
      receivedAt: 1_700_000_000_000,
      calledAt: 1_700_000_000_030,
      arrivedAt: 1_700_000_000_230,
      started: now,
      traceparent: null,
      defer: (promise) => {
        work.push(promise);
      },
      ...input,
    },
    () => now,
    () => 1_700_000_009_000,
  );
  return {
    event,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    async emitted() {
      await Promise.all(work);
      assert.equal(logged.length, 1);
      const spans: {
        name: string;
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        status?: { code: number };
        attributes: { key: string; value: { intValue?: string; stringValue?: string } }[];
      }[] = sent.length ? JSON.parse(sent[0]!.body).resourceSpans[0].scopeSpans[0].spans : [];
      return { event: logged[0]!, sent, spans };
    },
  };
}

const timings = (event: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(event).filter(([key]) => /^(?!duration).*Ms$/.test(key)));

test("each wait lands in its own hop and the hops are the whole request", async (context) => {
  const h = harness(context);
  h.advance(7);
  h.event.admitted();
  h.advance(11);
  h.event.dispatched();
  h.advance(400);
  h.event.firstByte();
  h.advance(2_000);
  h.event.end({ outcome: "complete", status: 200, bytes: 512 });
  const { event } = await h.emitted();

  assert.deepEqual(timings(event), {
    totalMs: 2_648,
    workerMs: 30,
    queueMs: 200,
    admissionMs: 7,
    dispatchMs: 11,
    firstByteMs: 400,
    streamMs: 2_000,
  });
  assert.equal(event.requestId, requestId);
  assert.equal(event.outcome, "complete");
  assert.equal(event.bytes, 512);
  assert.equal(event.inFlight, 4);
});

for (const [slow, hop] of [
  ["admission", "admissionMs"],
  ["dispatch", "dispatchMs"],
  ["runtime", "firstByteMs"],
] as const)
  test(`seven seconds lost in ${slow} show up in ${hop} and nowhere else`, async (context) => {
    const h = harness(context);
    h.advance(slow === "admission" ? 7_000 : 1);
    h.event.admitted();
    h.advance(slow === "dispatch" ? 7_000 : 1);
    h.event.dispatched();
    h.advance(slow === "runtime" ? 7_000 : 1);
    h.event.firstByte();
    h.event.end({ outcome: "responded", status: 200 });
    const { event } = await h.emitted();

    for (const other of ["admissionMs", "dispatchMs", "firstByteMs"])
      assert.equal(event[other], other === hop ? 7_000 : 1, other);
    assert.equal(event.streamMs, undefined);
  });

test("a request the runtime never answered has no first byte", async (context) => {
  const h = harness(context);
  h.advance(2);
  h.event.admitted();
  h.advance(3);
  h.event.dispatched();
  h.advance(7_000);
  h.event.set({ guard: "upstream_dispatch", cause: "TimeoutError" });
  h.event.end({ outcome: "outcome_unknown", status: 502 });
  const { event, spans } = await h.emitted();

  assert.equal(event.firstByteMs, undefined);
  assert.equal(event.unansweredMs, 7_000);
  assert.equal(event.totalMs, 30 + 200 + 2 + 3 + 7_000);
  assert.deepEqual(spans[0]!.status, { code: 2 });
  assert.ok(spans.some((span) => span.name === "pool.unanswered"));
});

test("a refusal before dispatch has neither a first byte nor an unanswered wait", async (context) => {
  const h = harness(context);
  h.advance(40);
  h.event.set({ guard: "model_membership", cause: "ModelMembershipUnavailable" });
  h.event.end({ outcome: "refused", status: 503 });
  const { event } = await h.emitted();

  assert.deepEqual(timings(event), { totalMs: 270, workerMs: 30, queueMs: 200, admissionMs: 40 });
  assert.equal(event.guard, "model_membership");
});

test("a call the Durable Object never answered is all queue", async (context) => {
  const h = harness(context, { arrivedAt: undefined, started: undefined, kind: undefined });
  h.event.set({ cause: "Error", overloaded: true });
  h.event.end({ outcome: "controller_unavailable" });
  const { event, spans } = await h.emitted();

  assert.deepEqual(timings(event), { totalMs: 9_000, workerMs: 30, queueMs: 8_970 });
  assert.equal(event.outcome, "controller_unavailable");
  assert.equal(event.overloaded, true);
  assert.equal(event.status, undefined);
  assert.deepEqual(spans[0]!.status, { code: 2 });
});

test("a call the Durable Object's own code failed is unanswered, not queue", async (context) => {
  const h = harness(context, { arrivedAt: undefined, started: undefined, kind: undefined });
  h.event.end({ outcome: "controller_failed" });
  const { event } = await h.emitted();

  assert.deepEqual(timings(event), { totalMs: 9_000, workerMs: 30, unansweredMs: 8_970 });
});

test("the trace carries the event on its root span and one span per hop that took time", async (context) => {
  const parent = "0af7651916cd43dd8448eb211c80319c";
  const h = harness(context, { traceparent: `00-${parent}-b7ad6b7169203331-01` });
  h.event.pool("pool-private-name");
  h.event.admitted();
  h.advance(5);
  h.event.dispatched();
  h.advance(60);
  h.event.firstByte();
  h.event.home([
    { stage: "selection", duration_ms: 12, outcome: "ok" },
    { stage: "rpop", duration_ms: 44, outcome: "timeout" },
    { stage: "private-stage", duration_ms: 1, outcome: "ok" },
    { stage: "ping", duration_ms: 1, outcome: "private outcome text" },
  ]);
  h.event.end({ outcome: "responded", status: 200 });
  const { event, sent, spans } = await h.emitted();

  assert.deepEqual(
    sent.map((entry) => [entry.url, entry.redirect]),
    [[env.SENTRY_OTLP_ENDPOINT, "manual"]],
  );
  const [root, ...children] = spans;
  assert.equal(root!.name, "pool POST /v1/chat/completions");
  assert.equal(root!.traceId, parent);
  assert.equal(root!.parentSpanId, "b7ad6b7169203331");
  assert.equal(event.traceId, parent);
  const attributes = Object.fromEntries(
    root!.attributes.map(({ key, value }) => [key, value.intValue ?? value.stringValue]),
  );
  assert.equal(attributes["pool.requestId"], requestId);
  assert.equal(attributes["pool.totalMs"], "295");
  assert.equal(attributes["pool.queueMs"], "200");
  assert.equal(attributes["pool.homeSelectionMs"], "12");
  assert.equal(attributes["pool.homeRpopMs"], "44");
  assert.equal(attributes["pool.homeFaults"], "rpop:timeout");
  assert.equal(attributes["pool.homePingMs"], "1");
  assert.match(attributes["pool.poolRef"]!, /^[0-9a-f]{12}$/);
  // The admission took no time, so it has no span; the others follow each other without gaps.
  assert.deepEqual(
    children.map((span) => span.name),
    ["pool.worker", "pool.queue", "pool.dispatch", "pool.firstByte"],
  );
  assert.equal(root!.startTimeUnixNano, "1700000000000000000");
  assert.equal(children[0]!.startTimeUnixNano, root!.startTimeUnixNano);
  for (const [index, span] of children.entries()) {
    assert.equal(span.parentSpanId, root!.spanId);
    if (index) assert.equal(span.startTimeUnixNano, children[index - 1]!.endTimeUnixNano);
  }
  assert.equal(children.at(-1)!.endTimeUnixNano, root!.endTimeUnixNano);
  assert.doesNotMatch(JSON.stringify([event, sent]), /private/);
});

test("free text, malformed identifiers and unknown keys never become fields", async (context) => {
  const h = harness(context, {
    method: "PRIVATE-VERB",
    traceparent: "private-trace-header",
    route: "/v1/private path?key=1",
    requestId: "private-request-id",
    kind: "private-kind" as "other",
    port: Number.NaN,
    inFlight: -1,
  });
  h.event.set({
    guard: "private text with spaces",
    cause: "https://private.example/path?key=1",
    boot: "private-boot",
    responseRequestId: "not-a-uuid",
    ...({ prompt: "private-prompt" } as object),
  });
  h.event.set({ refusalReason: "runtime_port", boot: "11111111-1111-4111-8111-111111111111" });
  h.event.end({ outcome: "private-outcome" as "refused", status: 503 });
  const { event, sent } = await h.emitted();

  assert.equal(event.method, "OTHER");
  assert.equal(event.path, "/other");
  assert.match(String(event.requestId), /^[0-9a-f-]{36}$/);
  assert.equal(event.outcome, "unavailable");
  assert.equal(event.refusalReason, "runtime_port");
  assert.equal(event.boot, "11111111-1111-4111-8111-111111111111");
  for (const key of ["guard", "cause", "responseRequestId", "prompt", "kind", "port", "inFlight"])
    assert.equal(event[key], undefined, key);
  assert.doesNotMatch(JSON.stringify([event, sent]), /private/i);
});

test("an unsampled trace and a deployment without a trace endpoint are logged but not exported", async (context) => {
  const unsampled = harness(context, {
    traceparent: `00-${"1".repeat(32)}-b7ad6b7169203331-00`,
  });
  unsampled.event.end({ outcome: "responded", status: 200 });
  assert.deepEqual((await unsampled.emitted()).sent, []);
  context.mock.restoreAll();

  const unconfigured = harness(
    context,
    {},
    { SENTRY_DSN: env.SENTRY_DSN, SENTRY_OTLP_ENDPOINT: "" },
  );
  unconfigured.event.end({ outcome: "responded", status: 200 });
  const { event, sent } = await unconfigured.emitted();
  assert.deepEqual(sent, []);
  assert.equal(event.requestId, requestId);
});

test("only the first end counts", async (context) => {
  const h = harness(context);
  h.event.end({ outcome: "complete", status: 200, bytes: 1 });
  h.event.set({ guard: "upstream_response" });
  h.event.end({ outcome: "refused", status: 503 });
  const { event } = await h.emitted();
  assert.equal(event.outcome, "complete");
  assert.equal(event.guard, undefined);
});
