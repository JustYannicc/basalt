import assert from "node:assert/strict";
import { test } from "node:test";
import { captureError, sendFeedback, validSentryDsn, type SentryEnv } from "./sentry.ts";

const env: SentryEnv = {
  SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
  SENTRY_OTLP_ENDPOINT: "https://o123.ingest.de.sentry.io/api/456/integration/otlp/v1/traces",
};

interface EnvelopeItem {
  readonly header: Record<string, unknown>;
  readonly payload: Uint8Array;
}

function line(bytes: Uint8Array, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < bytes.byteLength && bytes[end] !== 10) end++;
  assert.ok(end < bytes.byteLength, "envelope line has a newline");
  return { value: new TextDecoder().decode(bytes.subarray(offset, end)), next: end + 1 };
}

function parseEnvelope(bytes: Uint8Array): { header: Record<string, unknown>; items: EnvelopeItem[] } {
  const envelopeHeader = line(bytes, 0);
  const header = JSON.parse(envelopeHeader.value) as Record<string, unknown>;
  const items: EnvelopeItem[] = [];
  let offset = envelopeHeader.next;
  while (offset < bytes.byteLength) {
    const itemLine = line(bytes, offset);
    const itemHeader = JSON.parse(itemLine.value) as Record<string, unknown>;
    const length = Number(itemHeader.length);
    assert.ok(Number.isSafeInteger(length) && length >= 0);
    const end = itemLine.next + length;
    assert.ok(end < bytes.byteLength, "item payload is followed by an envelope newline");
    items.push({ header: itemHeader, payload: bytes.subarray(itemLine.next, end) });
    assert.equal(bytes[end], 10, "length is payload bytes only; separator is not counted");
    offset = end + 1;
  }
  return { header, items };
}

async function withFetch<T>(mock: typeof fetch, work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

function bytesFrom(body: BodyInit | null | undefined): Promise<Uint8Array> {
  return new Response(body).arrayBuffer().then((value) => new Uint8Array(value));
}

test("Sentry DSNs require HTTPS, one password-free EU project path, and no query or fragment", () => {
  assert.equal(validSentryDsn(env.SENTRY_DSN), true);
  for (const dsn of [
    "",
    "https://fixture@o123.ingest.sentry.io/456",
    "http://fixture@o123.ingest.de.sentry.io/456",
    "https://fixture:password@o123.ingest.de.sentry.io/456",
    "https://fixture@o123.ingest.de.sentry.io:443/456",
    "https://fixture@o123.ingest.de.sentry.io/456?key=1",
    "https://fixture@o123.ingest.de.sentry.io/456#fragment",
    "https://fixture@o123.ingest.de.sentry.io/456/789",
    "https://fixture@not-sentry.example/456",
  ]) assert.equal(validSentryDsn(dsn), false, dsn);
  assert.equal(validSentryDsn("   "), false, "blank optional values disable Sentry");
});

test("feedback uses a feedback envelope, a route template, fixed error codes, and UTF-8 byte lengths", async () => {
  const calls: { url: string; headers: Headers; envelope: Uint8Array }[] = [];
  await withFetch(async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      envelope: await bytesFrom(init?.body),
    });
    return new Response(null, { status: 202 });
  }, async () => {
    const accepted = await sendFeedback(env, {
      accountId: "acct_42",
      message: "The export failed 🌱\nPlease fix it.",
      page: "/v1/models?prompt=private#fragment",
      errors: [
        { code: "stack_trace" },
        { code: "unhandled_rejection" },
        { code: "http_503" },
        { code: "email@example.test" },
      ],
      screenshot: {
        type: "image/png",
        data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString("base64"),
        name: "private-user-name.png",
      },
    });
    assert.equal(accepted, true);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://o123.ingest.de.sentry.io/api/456/envelope/");
  assert.equal(calls[0]!.headers.get("content-type"), "application/x-sentry-envelope");
  assert.equal(calls[0]!.headers.get("x-sentry-auth"), "Sentry sentry_version=7, sentry_client=basalt/1, sentry_key=fixture_public_key");
  const parsed = parseEnvelope(calls[0]!.envelope);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0]!.header.type, "feedback");
  assert.equal(parsed.items[0]!.header.length, parsed.items[0]!.payload.byteLength);
  const feedback = JSON.parse(new TextDecoder().decode(parsed.items[0]!.payload)) as {
    event_id: string;
    contexts: { feedback: Record<string, unknown>; basalt: { recent_error_codes: string[] } };
    user: { id: string };
  };
  assert.equal(parsed.header.event_id, feedback.event_id);
  assert.equal(feedback.contexts.feedback.message, "The export failed 🌱\nPlease fix it.");
  assert.equal(feedback.contexts.feedback.url, "/v1/:operation");
  assert.deepEqual(feedback.contexts.basalt.recent_error_codes, ["unhandled_rejection", "http_503"]);
  assert.deepEqual(feedback.user, { id: "acct_42" });
  assert.equal("contact_email" in feedback.contexts.feedback, false);

  const attachment = parsed.items[1]!;
  assert.equal(attachment.header.type, "attachment");
  assert.equal(attachment.header.filename, "screenshot.png");
  assert.equal(attachment.header.content_type, "image/png");
  assert.equal(attachment.header.length, attachment.payload.byteLength);
  assert.deepEqual([...attachment.payload], [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const wireText = new TextDecoder().decode(calls[0]!.envelope);
  assert.doesNotMatch(wireText, /private-user-name|prompt=private|fragment|email@example|stack_trace/);
  assert.equal(calls[0]!.envelope.includes(0), false, "binary data remains valid UTF-8 for this fixture");
});

test("invalid DSN, account, message, and screenshot fail closed without sending", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return new Response(null, { status: 204 }); }, async () => {
    assert.equal(await sendFeedback({ SENTRY_DSN: "" }, { accountId: "acct_1", message: "text", page: "/" }), false);
    assert.equal(await sendFeedback({ SENTRY_DSN: "https://bad@example.invalid/2" }, { accountId: "acct_1", message: "text", page: "/" }), false);
    assert.equal(await sendFeedback(env, { accountId: "person@example.test", message: "text", page: "/" }), false);
    assert.equal(await sendFeedback(env, { accountId: "acct_1", message: "  ", page: "/" }), false);
    assert.equal(await sendFeedback(env, { accountId: "acct_1", message: "x".repeat(4097), page: "/" }), false);
    assert.equal(await sendFeedback(env, {
      accountId: "acct_1", message: "text", page: "/",
      screenshot: { type: "image/jpeg", data: "iVBORw==", name: "wrong.jpg" },
    }), false);
    assert.equal(await sendFeedback(env, {
      accountId: "acct_1", message: "text", page: "/",
      screenshot: { type: "image/png", data: "not base64", name: "bad.png" },
    }), false);
  });
  assert.equal(calls, 0);
});

test("screenshots accept exactly 2 MiB and reject any larger decoded image", async () => {
  let calls = 0;
  const atLimit = new Uint8Array(2 * 1024 * 1024);
  atLimit.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const aboveLimit = new Uint8Array(2 * 1024 * 1024 + 1);
  aboveLimit.set([137, 80, 78, 71, 13, 10, 26, 10]);
  await withFetch(async () => { calls++; return new Response(null, { status: 204 }); }, async () => {
    assert.equal(await sendFeedback(env, {
      accountId: "acct_1", message: "text", page: "/",
      screenshot: { type: "image/png", data: Buffer.from(atLimit).toString("base64"), name: "limit.png" },
    }), true);
    assert.equal(await sendFeedback(env, {
      accountId: "acct_1", message: "text", page: "/",
      screenshot: { type: "image/png", data: Buffer.from(aboveLimit).toString("base64"), name: "above.png" },
    }), false);
  });
  assert.equal(calls, 1);
});

test("sendFeedback is true only for a 2xx acknowledgement and swallows transport failures", async () => {
  await withFetch(async () => new Response(null, { status: 503 }), async () => {
    assert.equal(await sendFeedback(env, { accountId: "acct_1", message: "text", page: "/" }), false);
  });
  await withFetch(async () => { throw new Error("private network detail"); }, async () => {
    assert.equal(await sendFeedback(env, { accountId: "acct_1", message: "text", page: "/" }), false);
    await assert.doesNotReject(captureError(env, "router_failure", "/", "acct_1"));
  });
  await withFetch(async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://redirect.fixture/" } });
  }, async () => {
    assert.equal(await sendFeedback(env, { accountId: "acct_1", message: "text", page: "/" }), false);
  });
});

test("captureError sends only a fixed code, template, and opaque account id", async () => {
  let sent: Uint8Array | undefined;
  await withFetch(async (_input, init) => {
    sent = await bytesFrom(init?.body);
    return new Response(null, { status: 200 });
  }, async () => {
    await captureError(env, "http_503", "/api/auth/callback?code=private#secret", "acct_3");
    await captureError(env, "Error: private exception", "/", "acct_3");
  });
  assert.ok(sent);
  const parsed = parseEnvelope(sent);
  assert.equal(parsed.items.length, 1, "unknown error descriptions are not sent");
  assert.equal(parsed.items[0]!.header.type, "event");
  const event = JSON.parse(new TextDecoder().decode(parsed.items[0]!.payload)) as Record<string, unknown>;
  assert.equal(parsed.header.event_id, event.event_id);
  assert.equal(event.message, "http_503");
  assert.deepEqual(event.fingerprint, ["basalt", "http_503"]);
  assert.deepEqual(event.tags, { error_code: "http_503", page_template: "/api/auth/:action" });
  assert.deepEqual(event.user, { id: "acct_3" });
  assert.equal("exception" in event, false);
  assert.doesNotMatch(new TextDecoder().decode(sent), /private exception|code=private|secret/);
});
