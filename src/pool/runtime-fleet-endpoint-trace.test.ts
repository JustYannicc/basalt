import assert from "node:assert/strict";
import { test } from "node:test";
import { EndpointTrace } from "./runtime-fleet/endpoint-trace.ts";
import { retainRuntimeFailure, runtimeFailureDiagnostic } from "./runtime-route-diagnostic.ts";
import { gatewayUnavailable } from "./gateway-failure.ts";

test("endpoint failures retain both attempts and join the gateway without raw error or request data", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const request = new Request("http://runtime/health?secret=private-query", {
    method: "POST",
    body: "private-body",
    headers: { authorization: "private-header" },
  });
  const first = Object.assign(new Error("disconnected private-token"), {
    disconnected: true,
    retryable: false,
    code: "ERR_DISCONNECTED",
  });
  const second = Object.assign(new TypeError("private-second-message"), { overloaded: false });
  const trace = new EndpointTrace(request, "test-slot", "test-cell");
  await assert.rejects(
    trace.send(1, async () => {
      throw first;
    }),
    (error) => error === first,
  );
  trace.eligible = true;
  trace.reconnected = true;
  trace.reconnectAcquired = true;
  await assert.rejects(
    trace.send(2, async () => {
      throw second;
    }),
    (error) => error === second,
  );
  trace.finish(second);
  assert.equal(log.mock.callCount(), 1);
  const [marker, serialized] = log.mock.calls[0]!.arguments;
  const fields = JSON.parse(serialized);
  assert.equal(marker, "POOL_RUNTIME_ENDPOINT_FAILURE");
  assert.equal(fields.path, "/health");
  assert.equal(fields.method, "POST");
  assert.equal(fields.slotId, "test-slot");
  assert.equal(fields.cellId, "test-cell");
  assert.equal(fields.identityHeaderPresent, false);
  assert.equal(fields.reconnectEligible, true);
  assert.equal(fields.reconnectRan, true);
  assert.equal(fields.reconnectOutcome, "error");
  assert.deepEqual(fields.attempts, [
    {
      attempt: 1,
      stub: 1,
      outcome: "error",
      error: {
        name: "Error",
        code: "ERR_DISCONNECTED",
        messageClass: "disconnected",
        isError: true,
        disconnected: true,
        retryable: false,
        overloaded: null,
      },
    },
    {
      attempt: 2,
      stub: 2,
      outcome: "error",
      error: {
        name: "TypeError",
        code: null,
        messageClass: "other",
        isError: true,
        disconnected: null,
        retryable: null,
        overloaded: false,
      },
    },
  ]);
  const diagnostic = runtimeFailureDiagnostic(second, "slot_health");
  const response = gatewayUnavailable({}, request, undefined, performance.now(), () => {}, {
    ...diagnostic,
    guard: "runtime_port",
    cause: "Error",
    refusalReason: "runtime_port",
  });
  assert.equal(response.status, 503);
  assert.equal(log.mock.calls[1]!.arguments[1].requestId, fields.requestId);
  assert.doesNotMatch(JSON.stringify(log.mock.calls.map((call) => call.arguments)), /private-/);
});

test("an HTTP refusal after reconnect retains its join when decoded into a new error", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const trace = new EndpointTrace(
    new Request("http://runtime/health", { method: "POST" }),
    "slot",
    "cell",
  );
  await assert.rejects(
    trace.send(1, async () => {
      throw new Error("network");
    }),
  );
  trace.eligible = true;
  trace.reconnected = true;
  trace.reconnectAcquired = true;
  const response = await trace.send(2, async () => new Response(null, { status: 409 }));
  trace.finish(response);
  assert.equal(JSON.parse(log.mock.calls[0]!.arguments[1]).reconnectOutcome, "refusal");
  const error = retainRuntimeFailure(response, new Error("refused"));
  assert.equal(
    runtimeFailureDiagnostic(error, "slot_health").runtimeEndpointRequestId,
    JSON.parse(log.mock.calls[0]!.arguments[1]).requestId,
  );
});

test("successful model calls and provider HTTP errors stay silent, while health decode errors retain the send", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const model = new EndpointTrace(
    new Request("http://runtime/v1/responses?private-query", {
      headers: { "X-Signalbox-Runtime-Identity": "private-identity" },
    }),
    "slot",
    "cell",
  );
  const provider = await model.send(1, async () => new Response(null, { status: 429 }));
  model.finish(provider);
  assert.equal(log.mock.callCount(), 0);
  const { BoundSlotDriver } = await import("./runtime-slots/transport.ts");
  const { slotIdentity } = await import("../../scripts/pool-tests/runtime-slots-fixture.ts");
  const driver = new BoundSlotDriver(() => ({
    fetch: async (request) => {
      const trace = new EndpointTrace(request, "slot", "cell");
      const response = await trace.send(1, async () => new Response("private-invalid-json"));
      trace.finish(response);
      return response;
    },
  }));
  await assert.rejects(driver.health(slotIdentity("candidate"), AbortSignal.timeout(2000)));
  assert.equal(log.mock.callCount(), 1);
  const fields = JSON.parse(log.mock.calls[0]!.arguments[1]);
  assert.deepEqual(fields.attempts, [{ attempt: 1, stub: 1, outcome: "response", status: 200 }]);
  assert.equal(fields.reconnectRan, false);
  assert.equal(fields.terminalError.name, "SyntaxError");
  assert.doesNotMatch(JSON.stringify(fields), /private-/);
});

test("unrecognized exception values and hostile getters never enter logs or replace the failure", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const error = Object.assign(new Error("private-body"), {
    name: "private-name",
    code: "private-code",
    retryable: "private-flag",
  });
  Object.defineProperty(error, "overloaded", {
    get() {
      throw new Error("private-getter");
    },
  });
  const trace = new EndpointTrace(
    new Request("http://runtime/private-path?private-query"),
    "slot",
    "cell",
  );
  await assert.rejects(
    trace.send(1, async () => {
      throw error;
    }),
    (value) => value === error,
  );
  trace.finish(error);
  const fields = JSON.parse(log.mock.calls[0]!.arguments[1]);
  assert.equal(fields.path, "other");
  assert.equal(fields.terminalError.name, "other");
  assert.equal(fields.terminalError.code, "other");
  assert.equal(fields.terminalError.retryable, "invalid");
  assert.doesNotMatch(JSON.stringify(fields), /private-/);
});

test("the shared health driver records primary endpoint failures without a fleet wrapper", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const { BoundSlotDriver } = await import("./runtime-slots/transport.ts");
  const { slotIdentity } = await import("../../scripts/pool-tests/runtime-slots-fixture.ts");
  const error = new Error("private-primary-error");
  const driver = new BoundSlotDriver(() => ({
    fetch: async () => {
      throw error;
    },
  }));
  await assert.rejects(
    driver.health(slotIdentity("primary"), AbortSignal.timeout(2000)),
    (value) => value === error,
  );
  assert.equal(log.mock.callCount(), 1);
  const fields = JSON.parse(log.mock.calls[0]!.arguments[1]);
  assert.equal(fields.path, "/health");
  assert.equal(fields.reconnectEligible, false);
  assert.equal(fields.reconnectRan, false);
  assert.equal(fields.attempts.length, 1);
  assert.equal(fields.attempts[0].error.name, "Error");
  assert.equal(fields.attempts[0].error.disconnected, null);
  assert.equal(
    runtimeFailureDiagnostic(error, "slot_health").runtimeEndpointRequestId,
    fields.requestId,
  );
  assert.doesNotMatch(JSON.stringify(fields), /private-/);
});

test("cancellation retains a disconnected first send and pending reconnect in one boundary record", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const { BoundSlotDriver } = await import("./runtime-slots/transport.ts");
  const { slotIdentity } = await import("../../scripts/pool-tests/runtime-slots-fixture.ts");
  const entered = Promise.withResolvers<void>(),
    late = Promise.withResolvers<Response>(),
    finished = Promise.withResolvers<void>();
  const control = new AbortController();
  const driver = new BoundSlotDriver(() => ({
    fetch: async (request) => {
      const trace = EndpointTrace.forRequest(request, "primary", "actual-cell");
      let result: unknown;
      try {
        await assert.rejects(
          trace.send(1, async () => {
            throw Object.assign(new Error("disconnected"), { disconnected: true });
          }),
        );
        trace.eligible = true;
        trace.reconnected = true;
        trace.reconnectAcquired = true;
        result = await trace.send(2, () => {
          entered.resolve();
          return late.promise;
        });
        throw new Error("expected pending reconnect failure");
      } catch (error) {
        result = error;
        throw error;
      } finally {
        trace.finish(result);
        finished.resolve();
      }
    },
  }));
  const work = driver.health(slotIdentity("primary"), control.signal);
  await entered.promise;
  control.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(work, { name: "AbortError" });
  const fields = JSON.parse(log.mock.calls[0]!.arguments[1]);
  assert.equal(fields.cellId, "actual-cell");
  assert.equal(fields.reconnectEligible, true);
  assert.equal(fields.reconnectRan, true);
  assert.equal(fields.reconnectOutcome, "pending");
  assert.equal(fields.attempts.length, 2);
  assert.equal(fields.attempts[0].error.disconnected, true);
  assert.equal(fields.attempts[1].outcome, "pending");
  late.reject(new Error("private-distinct-late-error"));
  await finished.promise;
  assert.equal(log.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(fields), /private-/);
});
