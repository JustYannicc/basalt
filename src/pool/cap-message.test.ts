import assert from "node:assert/strict";
import { test } from "node:test";
import { capMessage, rewriteCapResponse } from "./cap-message.ts";

const message = "user_period_limit_exceeded: period limit exceeded (window=7d mode=calendar used=2 limit=1 reset_at=2026-10-26T00:00:00Z)";
function refusal(value = message, status = 429) {
  return Response.json({ error: { message: value, type: "rate_limit_error", code: "rate_limit_exceeded" } }, { status });
}
for (const path of ["/v1/messages", "/v1/responses", "/v1/chat/completions"]) {
  test(`weekly refusal on ${path} keeps 429 and uses the protocol error shape`, async () => {
    const response = await rewriteCapResponse(refusal(), path);
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.message, capMessage);
    const body = await (await rewriteCapResponse(refusal(), path)).json();
    assert.equal(path === "/v1/messages" ? body.type : body.error.code, path === "/v1/messages" ? "error" : "user_period_limit_exceeded");
  });
}
test("successful, streaming, unrelated and oversized errors remain untouched", async () => {
  for (const response of [refusal(message, 200), refusal("provider rate limit"), refusal(message.replace("7d", "5h")),
    new Response("data: streamed", { status: 429, headers: { "Content-Type": "text/event-stream" } }),
    refusal(message + "x".repeat(9000)), new Response("{broken", { status: 429, headers: { "Content-Type": "application/json" } })]) {
    const expected = await response.clone().text();
    assert.equal(await rewriteCapResponse(response, "/v1/messages"), response);
    assert.equal(await response.text(), expected);
  }
});
test("success and SSE bodies are not pulled by the rewrite", async () => {
  let pulled = 0;
  const body = () => new ReadableStream({ pull() { pulled++; } }, { highWaterMark: 0 });
  for (const response of [new Response(body()), new Response(body(), { status: 429, headers: { "Content-Type": "text/event-stream" } })]) {
    assert.equal(await rewriteCapResponse(response, "/v1/messages"), response);
    assert.equal(response.bodyUsed, false);
    await response.body!.cancel();
  }
  assert.equal(pulled, 0);
});
