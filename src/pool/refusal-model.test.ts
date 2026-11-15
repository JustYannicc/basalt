import assert from "node:assert/strict";
import { test } from "node:test";
import { captureRefusalModel, refusalModelProvider } from "./refusal-model.ts";
import { baselinePrices } from "./public-price-baseline.ts";

for (const [model, provider] of [
  ["claude-opus-5-5", "claude"],
  ["anthropic/claude-opus-5.5-20261101", "claude"],
  ["gpt-6.1-sol", "codex"],
  ["grok-4.7", "xai"],
])
  test(`a requested ${model} uses its catalog lab and existing public price`, () => {
    assert.equal(refusalModelProvider(model!, "/v1/responses"), provider);
    assert.ok(baselinePrices({ provider: provider!, model: model! }).prices.length > 0);
  });

test("unregistered and contradictory aliases stay unattributed", () => {
  for (const model of [null, "unlisted-alias", "private/gpt-6.1-sol", "xai/claude-opus-5-5"])
    assert.equal(refusalModelProvider(model, "/v1/responses"), null);
  assert.equal(refusalModelProvider(null, "/typesafe/v1/systemone"), "typesafe");
});

test("refusal capture survives request-body transfer and returns only the model", async () => {
  const payload = { model: "gpt-6.1-sol", messages: [{ content: "private-prompt-sentinel" }] };
  const request = new Request("https://pool.example/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const capture = captureRefusalModel(request);
  const forwarded = new Request(request);
  assert.equal(await capture.read(), payload.model);
  assert.deepEqual(await forwarded.json(), payload);
});

test("dispatch discards the branch without consuming or changing the forwarded body", async () => {
  const raw = JSON.stringify({ model: "grok-4.7", input: "private-prompt-sentinel" });
  const request = new Request("https://pool.example/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
  const capture = captureRefusalModel(request);
  capture.discard();
  assert.equal(await request.text(), raw);
  assert.equal(await capture.read(), null);
});

test("a model route requires no body; absent, malformed and oversized JSON stay unknown", async () => {
  const route = new Request(
    "https://pool.example/v1beta/models/gemini-2.5-pro:streamGenerateContent",
    { method: "POST" },
  );
  assert.equal(await captureRefusalModel(route).read(), "gemini-2.5-pro");
  for (const body of [
    "{}",
    "not-json",
    '{"model":"private prompt with spaces"}',
    JSON.stringify({ model: "gpt-6.1-sol", input: "x".repeat(2_097_152) }),
  ]) {
    const request = new Request("https://pool.example/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const capture = captureRefusalModel(request);
    assert.equal(await capture.read(), null);
    assert.equal(await request.text(), body);
  }
});

test("a stalled metadata body has a bounded read and does not delay the refusal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => controller.close();
    },
  });
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  };
  const request = new Request("https://pool.example/v1/responses", init);
  const capture = captureRefusalModel(request);
  const result = capture.read();
  t.mock.timers.tick(250);
  assert.equal(await result, null);
  close();
  assert.equal(await request.text(), "");
});
