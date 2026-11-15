import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit } from "effect";
import { BarrierRefusal } from "./manifest.ts";
import {
  operationFailure,
  safeProviderFailure,
  safeProviderFailureChain,
  withOperation,
} from "./operation-failure.ts";

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

test("Wrangler subclasses with inherited Error.name retain only closed types and codes", () => {
  class UserError extends Error {}
  class RemoteSessionAuthenticationError extends Error {}
  for (const Failure of [UserError, RemoteSessionAuthenticationError]) {
    const error = new Failure("private-message");
    assert.equal(error.name, "Error");
    assert.deepEqual(safeProviderFailure(error), { type: Failure.name });
  }
  assert.deepEqual(
    safeProviderFailure(
      Object.assign(new Error("private"), { name: "APIError", status: 403, code: 10000 }),
    ),
    { type: "APIError", status: 403, codes: [10000] },
  );
});

test("Node codes and nested causes are allowlisted, depth bounded, cycle safe and message free", () => {
  const sentinel = "private-sentinel@fixture.invalid";
  const root = Object.assign(new Error(sentinel), { code: "MODULE_NOT_FOUND" });
  const nested = Object.assign(new Error(sentinel), {
    code: "ECONNRESET",
    url: sentinel,
    stack: sentinel,
    body: sentinel,
  });
  root.cause = nested;
  nested.cause = root;
  assert.deepEqual(safeProviderFailureChain(root), [
    { type: "Error", nodeCode: "MODULE_NOT_FOUND" },
    { type: "Error", nodeCode: "ECONNRESET" },
  ]);
  const unknown = {
    name: sentinel,
    _tag: sentinel,
    code: sentinel,
    status: 503,
    message: sentinel,
    cause: { name: "Error", code: sentinel },
  };
  assert.deepEqual(safeProviderFailureChain(unknown), [
    { type: "unknown", status: 503 },
    { type: "Error" },
  ]);
  assert.ok(!JSON.stringify(safeProviderFailureChain(unknown)).includes(sentinel));
  let deep: Error = new Error(sentinel);
  for (let index = 0; index < 20; index++) deep = new Error(sentinel, { cause: deep });
  assert.equal(safeProviderFailureChain(deep).length, 4);
  const hostile = Object.defineProperty({}, "_tag", {
    get() {
      throw new Error(sentinel);
    },
  });
  assert.deepEqual(safeProviderFailureChain(hostile), [{ type: "unknown" }]);
});
