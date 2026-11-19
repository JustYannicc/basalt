import assert from "node:assert/strict";
import { test } from "node:test";
import { MiniflareCoreError } from "../startup-profiler/node_modules/miniflare/dist/src/index.js";
import { Cause, Effect, Exit } from "effect";
import { BarrierRefusal } from "./manifest.ts";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { classCheckFailure } from "./class-refusal.ts";
import { refusalTable } from "./refusal-report.ts";
import {
  operationFailure,
  providerChanges,
  safeProviderFailure,
  safeProviderFailureChain,
  safeRequestShape,
  safeTransportMessage,
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
    { type: "Error", code: "MODULE_NOT_FOUND" },
    { type: "Error", code: "ECONNRESET" },
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

test("real Miniflare decorated names retain a closed class and runtime code", () => {
  const error = new MiniflareCoreError("ERR_RUNTIME_FAILURE", "private-miniflare-message");
  assert.equal(error.name, "MiniflareCoreError [ERR_RUNTIME_FAILURE]");
  assert.deepEqual(safeProviderFailure(error), {
    type: "MiniflareCoreError",
    code: "ERR_RUNTIME_FAILURE",
  });
});

test("hostile provider error arrays cannot discard the original operator diagnostic", () => {
  const { proxy, revoke } = Proxy.revocable([], {});
  revoke();
  const error = Object.assign(new Error("private-provider-message"), {
    errors: proxy,
    status: 403,
    code: 10000,
  });
  assert.deepEqual(safeProviderFailureChain(error), [
    { type: "Error", status: 403, codes: [10000] },
  ]);
});

test("an HTTP transport refusal names the request shape and fetch's cause, never ids or values", async () => {
  const privateValues = [
    "private-account-0123",
    "private-worker",
    "private-version",
    "private.example.invalid",
    "synthetic-secret-header",
    "token=secret",
    "10.1.2.3",
  ];
  const request = HttpClientRequest.get(
    "https://private.example.invalid/client/v4/accounts/private-account-0123/workers/scripts/private-worker/versions/private-version?token=secret",
  );
  const socket = Object.assign(new Error("connect ECONNRESET 10.1.2.3:443 private-worker"), {
    code: "ECONNRESET",
  });
  const fetchError = new TypeError(
    'Headers.append: "Bearer synthetic-secret-header" is an invalid header value for https://private.example.invalid/x via private.example.invalid:443',
    { cause: socket },
  );
  const exit = await Effect.runPromiseExit(
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause: fetchError }),
      }),
    ).pipe(withOperation("PoolWorker", "read-class-expansion")),
  );
  assert.ok(Exit.isFailure(exit));
  const failure = Cause.squash(exit.cause);
  const operation = operationFailure(failure, "PoolWorker", "read-class-expansion");
  const provider = operation.provider!;
  assert.deepEqual(provider, {
    type: "HttpClientError",
    reason: "TransportError",
    request: { method: "GET", path: "/client/v4/accounts/{id}/workers/scripts/{id}/versions/{id}" },
    cause: [
      {
        type: "TypeError",
        message: "Headers.append: [value] is an invalid header value for [url] via [host]",
      },
      { type: "Error", code: "ECONNRESET" },
    ],
  });
  const refusal = classCheckFailure(failure, "PoolWorker");
  const rows = refusal.delta?.changed ?? [];
  for (const path of [
    "$provider.request.method",
    "$provider.request.path",
    "$provider.cause.0.type",
    "$provider.cause.0.message",
    "$provider.cause.1.code",
  ])
    assert.ok(
      rows.some((row) => row.path === path),
      `missing ${path}`,
    );
  const table = refusalTable({
    reason: operation.reason,
    worker: "PoolWorker",
    operation: operation.operation,
    provider: operation.provider,
  });
  assert.ok(
    table.includes("request=GET /client/v4/accounts/{id}/workers/scripts/{id}/versions/{id}"),
  );
  assert.ok(table.includes("cause.1=Error: ECONNRESET"));
  for (const output of [JSON.stringify(rows), JSON.stringify(providerChanges(provider)), table])
    for (const value of privateValues) assert.ok(!output.includes(value), `leaked ${value}`);
});

test("a top-level code-bug TypeError keeps the identifier it names", () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'accountId')");
  assert.equal(
    operationFailure(error, "PoolWorker", "read-class-expansion").provider?.message,
    "Cannot read properties of undefined (reading 'accountId')",
  );
});

for (const [input, expected] of [
  ["connect to API.Example.COM:443 refused", "connect to [host] refused"],
  [
    "Headers.append: invalid; Response.json failed",
    "Headers.append: invalid; Response.json failed",
  ],
  ["read file:///home/someone/x and ws://private/y", "read [url] and [url]"],
  ["bad 2001:db8::1 or ::1 or [fe80::1]:443", "bad [address] or [address] or [address]"],
  ['unterminated "private value with no close', "unterminated [value]"],
  ["can't reach 'private' and don't retry", "can't reach [value] and don't retry"],
  ['fetching "https://private.invalid/x" failed', 'fetching "[url]" failed'],
] as const)
  test(`transport messages drop private text: ${input}`, () => {
    assert.equal(safeTransportMessage(input), expected);
  });

for (const [path, expected] of [
  ["/accounts/a/r2/buckets/assets/cors", "/accounts/{id}/r2/buckets/{id}/cors"],
  ["/accounts/a/workers/scripts/settings/settings", "/accounts/{id}/workers/scripts/{id}/settings"],
  [
    "/client/v4/accounts/a/workers/workers/workers/versions/v",
    "/client/v4/accounts/{id}/workers/workers/{id}/versions/{id}",
  ],
  ["/accounts/a/d1/database/query/query", "/accounts/{id}/d1/database/{id}/query"],
  ["/accounts/a/private-unknown-word", "/accounts/{id}/{id}"],
] as const)
  test(`request paths template identifiers by position: ${path}`, () => {
    assert.deepEqual(
      safeRequestShape({ method: "GET", url: `https://private.invalid${path}?token=secret` }),
      { method: "GET", path: expected },
    );
  });
