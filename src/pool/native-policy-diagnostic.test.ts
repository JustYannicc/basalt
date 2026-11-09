import assert from "node:assert/strict";
import { test } from "node:test";
import { readNativePolicyReason, nativePolicyReasons } from "./native-policy-diagnostic.ts";

for (const reason of nativePolicyReasons)
  test(`only the closed ${reason} class survives backend diagnostics`, async () => {
    const response = Response.json(
      {
        error: "invalid_projection",
        reason,
        accountIndex: 3,
        leaseMs: 15001,
        private: "private-response-sentinel",
        projection: "private-envelope",
      },
      { status: 400 },
    );
    assert.equal(await readNativePolicyReason(response, new AbortController().signal), reason);
  });

test("unknown, malformed, oversized and unrelated bodies provide no diagnostic", async () => {
  for (const response of [
    Response.json({ error: "invalid_projection", reason: "private-sentinel" }),
    Response.json({ error: "private-sentinel", reason: "json" }),
    Response.json({ reason: "json" }),
    new Response("not-json"),
    new Response(
      JSON.stringify({ error: "invalid_projection", reason: "json", private: "x".repeat(1024) }),
    ),
    new Response(null),
  ])
    assert.equal(await readNativePolicyReason(response, new AbortController().signal), undefined);
});

test("a stalled diagnostic body shares the caller's deadline and is cancelled", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const controller = new AbortController();
  const pending = readNativePolicyReason(response, controller.signal);
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(cancelled, true);
});

test("a failed or already-locked diagnostic body cannot replace the HTTP refusal", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private-reader-sentinel"));
      },
    }),
  );
  assert.equal(await readNativePolicyReason(response, new AbortController().signal), undefined);
  const locked = Response.json({ reason: "json" });
  const reader = locked.body!.getReader();
  assert.equal(await readNativePolicyReason(locked, new AbortController().signal), undefined);
  await reader.cancel();
});
