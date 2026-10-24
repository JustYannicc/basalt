import assert from "node:assert/strict";
import { test } from "node:test";
import { traceRequest, type TraceEnv, type TraceExecutionContext } from "./traces.ts";

const env: TraceEnv = {
  SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
  SENTRY_OTLP_ENDPOINT: "https://o123.ingest.de.sentry.io/api/456/integration/otlp/v1/traces",
};

async function withFetch<T>(mock: typeof fetch, work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

function deferredContext(): { context: TraceExecutionContext; work: Promise<unknown>[] } {
  const work: Promise<unknown>[] = [];
  return { context: { waitUntil: (promise) => { work.push(promise); } }, work };
}

function parseEnvelope(bytes: Uint8Array) {
  const firstEnd = bytes.indexOf(10);
  assert.ok(firstEnd >= 0);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, firstEnd))) as Record<string, unknown>;
  const itemStart = firstEnd + 1;
  const itemEnd = bytes.indexOf(10, itemStart);
  assert.ok(itemEnd >= 0);
  const item = JSON.parse(new TextDecoder().decode(bytes.subarray(itemStart, itemEnd))) as Record<string, unknown>;
  const payloadStart = itemEnd + 1;
  return {
    header,
    item,
    payload: JSON.parse(new TextDecoder().decode(bytes.subarray(payloadStart, payloadStart + Number(item.length)))) as Record<string, unknown>,
  };
}

test("traceRequest propagates a validated child traceparent and exports fixed route/method/status only", async () => {
  const requests: { url: string; headers: Headers; body: string; redirect: string | undefined }[] = [];
  const deferred = deferredContext();
  const parentTraceId = "0123456789abcdef0123456789abcdef";
  const parentSpanId = "0123456789abcdef";
  const response = await withFetch(async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body), redirect: init?.redirect });
    return new Response(null, { status: 204 });
  }, () => traceRequest(
    env,
    new Request("https://fixture.invalid/v1/models?token=private#fragment", {
      headers: {
        traceparent: `00-${parentTraceId}-${parentSpanId}-01`,
        baggage: "user=private",
        tracestate: "vendor=private",
        authorization: "Bearer private",
      },
    }),
    async (forwarded) => {
      const child = forwarded.headers.get("traceparent");
      assert.match(child ?? "", /^00-0123456789abcdef0123456789abcdef-(?!0123456789abcdef)[0-9a-f]{16}-01$/);
      assert.equal(forwarded.headers.get("baggage"), null);
      assert.equal(forwarded.headers.get("tracestate"), null);
      assert.equal(forwarded.headers.get("authorization"), "Bearer private", "ordinary request auth is forwarded to the service binding");
      return new Response("ok", { status: 200 });
    },
    deferred.context,
  ));

  assert.equal(await response.text(), "ok");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, env.SENTRY_OTLP_ENDPOINT);
  assert.equal(requests[0]!.headers.get("content-type"), "application/json");
  assert.equal(requests[0]!.redirect, "manual");
  assert.equal(requests[0]!.headers.get("x-sentry-auth"), "sentry sentry_key=fixture_public_key");
  assert.equal(deferred.work.length, 1);
  await Promise.all(deferred.work);

  const exported = JSON.parse(requests[0]!.body) as {
    resourceSpans: [{ scopeSpans: [{ spans: [Record<string, unknown>] }] }];
  };
  const span = exported.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  assert.equal(span.traceId, parentTraceId);
  assert.equal(span.parentSpanId, parentSpanId);
  assert.equal(span.name, "GET /v1/:operation");
  assert.equal(span.kind, 2);
  const attributes = span.attributes as { key: string; value: Record<string, unknown> }[];
  assert.deepEqual(attributes, [
    { key: "http.request.method", value: { stringValue: "GET" } },
    { key: "http.route", value: { stringValue: "/v1/:operation" } },
    { key: "http.response.status_code", value: { intValue: "200" } },
  ]);
  assert.equal("status" in span, false);
  assert.doesNotMatch(requests[0]!.body, /fixture\.invalid|token=private|fragment|authorization|private/);
});

test("trace export is deferred and does not add ingestion latency to the response", async () => {
  let resolveFetch!: (response: Response) => void;
  const deferred = deferredContext();
  const task = withFetch(async () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    () => traceRequest(env, new Request("https://fixture.invalid/"), async () => new Response("ready"), deferred.context));
  const result = await Promise.race([
    task,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);
  assert.ok(result instanceof Response, "handler response resolves before the OTLP collector");
  assert.equal(await (result as Response).text(), "ready");
  assert.equal(deferred.work.length, 1);
  resolveFetch(new Response(null, { status: 200 }));
  await task;
  await Promise.all(deferred.work);
});

test("invalid traceparent starts a fresh trace and never propagates baggage or tracestate", async () => {
  const deferred = deferredContext();
  const calls: string[] = [];
  await withFetch(async (_input, init) => {
    calls.push(String(init?.body));
    return new Response(null, { status: 204 });
  }, async () => {
    await traceRequest(env, new Request("https://fixture.invalid/mcp?private=yes", {
      headers: { traceparent: "00-00000000000000000000000000000000-0000000000000000-01", baggage: "secret", tracestate: "secret" },
      method: "POST",
    }), async (forwarded) => {
      const traceparent = forwarded.headers.get("traceparent") ?? "";
      assert.match(traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      assert.equal(forwarded.headers.get("baggage"), null);
      assert.equal(forwarded.headers.get("tracestate"), null);
      return new Response(null, { status: 418 });
    }, deferred.context);
  });
  await Promise.all(deferred.work);
  const payload = JSON.parse(calls[0]!) as {
    resourceSpans: [{ scopeSpans: [{ spans: [Record<string, unknown>] }] }];
  };
  const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  assert.match(String(span.traceId), /^[0-9a-f]{32}$/);
  assert.equal("parentSpanId" in span, false);
  assert.equal(span.name, "POST /mcp");
  assert.equal(span.status, undefined, "client status is recorded as an attribute but not an internal error");
  assert.doesNotMatch(calls[0]!, /fixture\.invalid|private=yes|secret/);
});

test("5xx responses report only a fixed error code and mark the span failed", async () => {
  const calls: { body: BodyInit | null | undefined; contentType: string }[] = [];
  const deferred = deferredContext();
  await withFetch(async (_input, init) => {
    calls.push({ body: init?.body, contentType: new Headers(init?.headers).get("content-type") ?? "" });
    return new Response(null, { status: 204 });
  }, async () => {
    await traceRequest(env, new Request("https://fixture.invalid/pool/v1/sign-ins?code=secret"), async () =>
      new Response("private response body", { status: 503 }), deferred.context);
  });
  await Promise.all(deferred.work);
  assert.equal(calls.length, 2, "one error event and one OTLP batch");
  const errorBody = await new Response(calls[0]!.body).arrayBuffer();
  const error = parseEnvelope(new Uint8Array(errorBody));
  assert.equal(error.item.type, "event");
  assert.equal(error.payload.message, "http_503");
  assert.deepEqual(error.payload.tags, { error_code: "http_503", page_template: "/pool/v1/:action" });
  assert.doesNotMatch(new TextDecoder().decode(errorBody), /secret|private response body|fixture\.invalid/);
  const trace = JSON.parse(String(calls[1]!.body)) as {
    resourceSpans: [{ scopeSpans: [{ spans: [Record<string, unknown>] }] }];
  };
  assert.equal(trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status && (trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status as { code: number }).code, 2);
  assert.equal(calls[1]!.contentType, "application/json");
});

test("a rejected handler is rethrown unchanged while exports omit the exception text", async () => {
  const deferred = deferredContext();
  const calls: string[] = [];
  await withFetch(async (_input, init) => {
    const body = await new Response(init?.body).arrayBuffer();
    calls.push(new TextDecoder().decode(body));
    return new Response(null, { status: 202 });
  }, async () => {
    await assert.rejects(
      traceRequest(env, new Request("https://fixture.invalid/v1/completions?prompt=private"), async () => {
        throw new Error("private request body and stack");
      }, deferred.context),
      /private request body and stack/,
    );
  });
  await Promise.all(deferred.work);
  assert.equal(calls.length, 2, "router failure event and server span");
  assert.ok(calls.some((body) => body.includes("router_failure")));
  assert.ok(calls.some((body) => body.includes("\"status\":{\"code\":2}")));
  for (const body of calls) assert.doesNotMatch(body, /private request body|prompt=private|fixture\.invalid/);
});

test("Sentry traces require both a valid EU DSN and the explicit EU OTLP URL", async () => {
  const calls: string[] = [];
  const deferred = deferredContext();
  await withFetch(async (input) => {
    calls.push(String(input));
    return new Response(null, { status: 200 });
  }, async () => {
    await traceRequest({ SENTRY_DSN: "", SENTRY_OTLP_ENDPOINT: env.SENTRY_OTLP_ENDPOINT }, new Request("https://fixture.invalid/"), async () => new Response());
    await traceRequest({ SENTRY_DSN: env.SENTRY_DSN, SENTRY_OTLP_ENDPOINT: "" }, new Request("https://fixture.invalid/"), async () => new Response());
    await traceRequest({ SENTRY_DSN: env.SENTRY_DSN, SENTRY_OTLP_ENDPOINT: "https://o999.ingest.de.sentry.io/api/456/traces" }, new Request("https://fixture.invalid/"), async () => new Response());
    await traceRequest(env, new Request("https://fixture.invalid/"), async () => new Response(), deferred.context);
  });
  await Promise.all(deferred.work);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], env.SENTRY_OTLP_ENDPOINT);
});

test("reporting and telemetry routes bypass both exporters and still strip propagation baggage", async () => {
  const deferred = deferredContext();
  let calls = 0;
  await withFetch(async () => { calls++; return new Response(null, { status: 204 }); }, async () => {
    for (const path of ["/__telemetry/v1/traces", "/feedback/v1/error", "/api/telemetry/ingest"]) {
      const response = await traceRequest(env, new Request(`https://fixture.invalid${path}?private=value`, {
        headers: {
          traceparent: "untrusted trace context",
          baggage: "user=private",
          tracestate: "vendor=private",
        },
      }), async (forwarded) => {
        assert.equal(forwarded.headers.get("traceparent"), null);
        assert.equal(forwarded.headers.get("baggage"), null);
        assert.equal(forwarded.headers.get("tracestate"), null);
        return new Response(null, { status: 503 });
      }, deferred.context);
      assert.equal(response.status, 503);
    }
  });
  assert.equal(calls, 0);
  assert.equal(deferred.work.length, 0);
});

test("the forwarded request preserves its body while adding trace context", async () => {
  const deferred = deferredContext();
  let forwardedBody = "";
  await withFetch(async () => new Response(null, { status: 204 }), async () => {
    await traceRequest(env, new Request("https://fixture.invalid/v1/models?key=private", {
      method: "POST",
      body: "request body must not enter the span",
    }), async (forwarded) => {
      assert.match(forwarded.headers.get("traceparent") ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      forwardedBody = await forwarded.text();
      return new Response(null, { status: 200 });
    }, deferred.context);
  });
  await Promise.all(deferred.work);
  assert.equal(forwardedBody, "request body must not enter the span");
});

test("trace ingestion does not follow a redirect response", async () => {
  const deferred = deferredContext();
  let calls = 0;
  await withFetch(async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://redirect.fixture/" } });
  }, async () => {
    await traceRequest(env, new Request("https://fixture.invalid/"), async () => new Response(null, { status: 200 }), deferred.context);
  });
  await Promise.all(deferred.work);
  assert.equal(calls, 1);
});
