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
    assert.deepEqual(await readNativePolicyReason(response, new AbortController().signal), {
      reason,
      ...(reason === "lease_window" ? { leaseMs: 15001 } : {}),
    });
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

test("only bounded integral lease-window milliseconds survive the diagnostic body", async () => {
  for (const leaseMs of [
    -60_000,
    -1,
    0,
    15_001,
    60_000,
    -60_001,
    60_001,
    1.5,
    "15001",
    null,
    true,
  ]) {
    const response = Response.json({
      error: "invalid_projection",
      reason: "lease_window",
      leaseMs,
      private: "private-sentinel",
    });
    const bounded =
      typeof leaseMs === "number" && Number.isInteger(leaseMs) && Math.abs(leaseMs) <= 60_000;
    assert.deepEqual(await readNativePolicyReason(response, new AbortController().signal), {
      reason: "lease_window",
      ...(bounded ? { leaseMs } : {}),
    });
  }
});
