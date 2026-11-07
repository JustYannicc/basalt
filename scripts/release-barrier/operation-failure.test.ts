import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit } from "effect";
import { BarrierRefusal } from "./manifest.ts";
import { operationFailure, safeProviderFailure, withOperation } from "./operation-failure.ts";

for (const error of [
  { _tag: "private-token", status: "503", code: "credential", message: "secret" },
  { _tag: "private-token", status: Infinity, code: NaN, errors: [{ code: -1 }] },
  "private-token",
  null,
])
  test("unrecognized provider data cannot enter public diagnostics", () => {
    assert.deepEqual(safeProviderFailure(error), { type: "unknown" });
  });

test("Cloudflare envelope codes are bounded and copied without provider messages", () => {
  assert.deepEqual(
    safeProviderFailure({
      _tag: "CloudflareError",
      status: 403,
      errors: [
        { code: 10000, message: "secret" },
        { code: 10000 },
        { code: 10001 },
        { code: 0.5 },
        { code: 2 ** 40 },
        { code: "private-token" },
      ],
    }),
    { type: "CloudflareError", status: 403, codes: [10000, 10001] },
  );
});

test("wrapping preserves an admission refusal and its redacted delta", () => {
  const delta = {
    fqn: "Api",
    type: "Cloudflare.Worker",
    changed: [{ path: "env", changed: true as const }],
  };
  const refusal = new BarrierRefusal("script-settings-change", "Api", delta);
  const wrapped = operationFailure(refusal, "Other", "freeze-worker-upload");
  assert.equal(wrapped.reason, refusal.reason);
  assert.equal(wrapped.worker, "Api");
  assert.equal(wrapped.delta, delta);
  assert.equal(wrapped.provider, undefined);
  assert.equal(operationFailure(wrapped, "Other", "release-stack"), wrapped);
});

test("pure interruption remains interruption", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.interrupt.pipe(withOperation("Api", "prepare-resource")),
  );
  assert.ok(Exit.isFailure(exit));
  assert.ok(Cause.hasInterruptsOnly(exit.cause));
});
