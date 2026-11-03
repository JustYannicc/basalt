import assert from "node:assert/strict";
import { test } from "node:test";
import { captureModelProbeResponse } from "./model-probe-response.ts";

test("captures root error fields and nested detail without retaining credentials", async () => {
  const captured = await captureModelProbeResponse(new Response(JSON.stringify({
    _tag: "ToolCallFailed", message: "The model request failed", reason: "pool_unavailable",
    failure: { code: "upstream", message: "Bearer synthetic-bearer", access_token: "opaque-value" },
    headers: { "set-cookie": "session=synthetic-cookie" },
    envelope: "opaque-envelope", apiKey: "synthetic-key", password: "synthetic-password",
    session_token: "opaque-session", sessionToken: "opaque-session", signingKey: "opaque-signing-key",
  }), { status: 502 }));
  assert.equal(captured.status, 502);
  assert.equal(captured.ok, false);
  assert.equal(captured.truncated, false);
  assert.equal(captured.readFailed, false);
  assert.deepEqual(JSON.parse(captured.body), {
    _tag: "ToolCallFailed", message: "The model request failed", reason: "pool_unavailable",
    failure: { code: "upstream", message: "<REDACTED>", access_token: "<REDACTED>" },
    headers: "<REDACTED>", envelope: "<REDACTED>", apiKey: "<REDACTED>", password: "<REDACTED>",
    session_token: "<REDACTED>", sessionToken: "<REDACTED>", signingKey: "<REDACTED>",
  });
});

test("keeps plain-text and malformed JSON failures with secrets removed", async () => {
  for (const body of [
    'Upstream refused: Authorization: Bearer synthetic-bearer\nCookie: session=opaque\nHTTP 502',
    '{"_tag":"ToolCallFailed","access_token":"opaque-value',
    '{"_tag":"ToolCallFailed","headers":{"custom":"opaque-value',
    '{"_tag":"ToolCallFailed","cookie":"session=opaque-value',
    '{"_tag":"ToolCallFailed","set-cookie":"session=opaque-value',
    '{"_tag":"ToolCallFailed","sessionToken":"opaque-value',
    'failed sk-synthetic-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature https://user:pass@example.com/path',
  ]) {
    const captured = await captureModelProbeResponse(new Response(body, { status: 502 }));
    assert.match(captured.body, /<REDACTED>/);
    assert.doesNotMatch(captured.body, /synthetic-bearer|session=opaque|opaque-value|sk-synthetic|eyJ|user:pass/);
  }
});

test("bounds a streamed failure, cancels it and redacts a cut-off secret", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"message":"failed","access_token":"' + 'x'.repeat(32_768)));
    },
    cancel() { cancelled = true; },
  });
  const captured = await captureModelProbeResponse(new Response(body, { status: 502 }));
  assert.equal(captured.truncated, true);
  assert.equal(cancelled, true);
  assert.ok(new TextEncoder().encode(captured.body).byteLength <= 16_384);
  assert.match(captured.body, /failed/);
  assert.doesNotMatch(captured.body, /xxx/);
  const unicode = await captureModelProbeResponse(new Response("⚠".repeat(10_000), { status: 502 }));
  assert.equal(unicode.truncated, true);
  assert.ok(new TextEncoder().encode(unicode.body).byteLength <= 16_384);
});

test("preserves successful completion usage and empty or broken response outcomes", async () => {
  const body = { value: { content: "OK", usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } } };
  const captured = await captureModelProbeResponse(new Response(JSON.stringify(body)));
  assert.equal(captured.ok, true);
  assert.deepEqual(JSON.parse(captured.body), body);
  assert.equal((await captureModelProbeResponse(new Response(null, { status: 502 }))).body, "");
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private transport error")); } });
  const failure = await captureModelProbeResponse(new Response(broken, { status: 502 }));
  assert.equal(failure.readFailed, true);
  assert.equal(failure.body, "");
});
