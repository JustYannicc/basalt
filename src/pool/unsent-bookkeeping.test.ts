import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PoolLifecycle } from "./lifecycle.ts";
import { NativeMemberships } from "./membership.ts";
import {
  nativeControlPath,
  nativeControlPrefix,
  nativeModelHeader,
  nativeModelPrefix,
} from "./native-contract.ts";
import { NativeStreams } from "./native-streams.ts";
import { RuntimeProtection } from "./runtime-protection.ts";
import { correlateEndpointRequest, rememberRuntimeFailure } from "./runtime-route-diagnostic.ts";
import { unsentRefusal } from "./controller-unsent.ts";
import { rootFallbackRefused } from "./runtime-fleet/root-fallback.ts";
import { fixture, owner, pool, signingKey } from "./test/computers.ts";
import { signEnvelope } from "./token.ts";

const mark = "X-Signalbox-Controller-Unsent";
const attemptHeader = "X-Signalbox-Unsent-Attempt";

type Route = (request: Request, ...rest: unknown[]) => Promise<Response>;

/** A native model call through the real forward path, with a recorder that keeps every row. */
async function forwarding(context: TestContext) {
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "info", () => {});
  const f = fixture();
  const streams = new NativeStreams();
  const never = async (): Promise<never> => {
    throw new Error("Unexpected control operation");
  };
  const memberships = new NativeMemberships({
    storage: f.storage,
    signingKey,
    read: never,
    actual: never,
    reconcile: never,
    install: never,
    abort: () => assert.fail("Unexpected abort"),
    schedule: never,
  });
  const lifecycle = new PoolLifecycle(
    { running: () => true, start: never, stop: never, keepAlive: never, status: never },
    {
      ...f.storage,
      get: (key) => f.storage.get(key),
      put: (key, value) => f.storage.put(key, value),
      getAlarm: never,
      setAlarm: never,
    },
    "fixture",
  );
  const starts: string[] = [];
  const finishes: { id: string; outcome: string; status: number }[] = [];
  const deferred: Promise<unknown>[] = [];
  let route: Route = async () => assert.fail("no route set");
  const deps = {
    env: { POOL_APP_SIGNING_KEY: signingKey },
    computers: { nativeModel: f.nativeModel, observeUsage: async () => {} },
    memberships,
    streams,
    lifecycle: Promise.resolve(lifecycle),
    protection: new RuntimeProtection(streams, {
      check: never,
      defer: () => {},
      unavailable: () => {},
    }),
    route: (request: Request, ...rest: unknown[]) => route(request, ...rest),
    fetch: never,
    defer: (work: Promise<unknown>) => {
      deferred.push(work);
    },
    terminal: {
      start: async (input: { requestId: string }) => {
        starts.push(input.requestId);
      },
      finish: async (id: string, result: { outcome: string; status: number }) => {
        finishes.push({ id, outcome: result.outcome, status: result.status });
      },
    },
  };
  const module = "./forward.worker.ts";
  const { forwardPoolRequest } = (await import(module)) as {
    forwardPoolRequest(request: Request, port: 8317, dependencies: typeof deps): Promise<Response>;
  };
  const grant = "native:unsent-fixture";
  const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
    action: "register",
    user: owner,
    grant,
    models: true,
    tools: true,
    expiresAt: f.now() + 10_000,
    intent: await f.intent(owner),
    name: "Unsent fixture",
  });
  const registration = await f.nativeControl(
    new Request(`https://pool.example${nativeControlPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
  );
  const { computer } = (await registration.json()) as { computer: { id: string } };
  const call = async (headers: Record<string, string> = {}) =>
    new Request("https://pool.example/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [nativeModelHeader]: await signEnvelope(signingKey, nativeModelPrefix, {
          user: owner,
          grant,
          computer: computer.id,
          pool: pool.pool,
          expiresAt: f.now() + 10_000,
          method: "POST",
          path: "/v1/messages",
        }),
        ...headers,
      },
      body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }),
    });
  return {
    send: async (request: Request, next: Route) => {
      route = next;
      return forwardPoolRequest(request, 8317, deps);
    },
    call,
    starts,
    finishes,
    settle: async () => {
      while (deferred.length) await Promise.all(deferred.splice(0));
    },
  };
}

/**
 * The route as the fleet answers a call its runtime refused before the container send: the retry
 * path's own unsent refusal, built from the endpoint's error, which carries the endpoint's trace id.
 */
const unsentAnswer: Route = async (request, ...rest) => {
  (rest[3] as () => void)();
  const error = new Error("endpoint readiness refused");
  rememberRuntimeFailure("endpoint_health", error);
  correlateEndpointRequest(error, "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
  return unsentRefusal(request, error);
};

/** The node's answer, which echoes the call's pool request id. */
const nodeAnswer: Route = async (request, ...rest) => {
  (rest[3] as () => void)();
  return Response.json(
    { id: "message" },
    { headers: { "X-Basalt-Request-Id": request.headers.get("X-Basalt-Request-Id") ?? "" } },
  );
};

test("a call never sent and then sent again is recorded once, by the answer its client got", async (context) => {
  const h = await forwarding(context);
  const logged = context.mock.method(console, "error", () => {});
  const refused = await h.send(await h.call(), unsentAnswer);
  assert.equal(refused.status, 503);
  const attempt = refused.headers.get("X-Request-Id");
  assert.ok(attempt);
  // The route failure names the endpoint's trace and the attempt its client sees, so both match.
  const [route] = logged.mock.calls.filter(
    (call) => call.arguments[0] === "POOL_RUNTIME_ROUTE_FAILURE",
  );
  assert.ok(route);
  const routed = route.arguments[1] as { requestId: string; attemptRequestId?: string };
  assert.equal(routed.requestId, "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
  assert.equal(routed.attemptRequestId, attempt);
  await refused.text();
  await h.settle();
  assert.deepEqual(h.finishes, [], "the attempt that never ran records no outcome");
  // The entry sends it again with the refused attempt's id: one request, one row.
  const answered = await h.send(await h.call({ [attemptHeader]: attempt }), nodeAnswer);
  assert.equal(answered.status, 200);
  assert.equal(answered.headers.get("X-Request-Id"), attempt);
  await answered.text();
  await h.settle();
  assert.deepEqual(new Set(h.starts), new Set([attempt]));
  assert.deepEqual(h.finishes, [{ id: attempt, outcome: "complete", status: 200 }]);
});

test("a call refused by its runtime's endpoint before the send records no outcome either", async (context) => {
  const h = await forwarding(context);
  const logged = context.mock.method(console, "error", () => {});
  const trace = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const refused = await h.send(await h.call(), async (_request, ...rest) => {
    (rest[3] as () => void)();
    const error = new Error("endpoint readiness refused");
    rememberRuntimeFailure("endpoint_health", error);
    correlateEndpointRequest(error, trace);
    throw error;
  });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get(mark), "1");
  await refused.text();
  await h.settle();
  assert.deepEqual(h.finishes, []);
  // Its one line names the endpoint's trace beside the attempt, so the two can be matched.
  const lines = logged.mock.calls.filter((call) => call.arguments[0] === "POOL_CONTROLLER_UNSENT");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(String(lines[0]!.arguments[1])), {
    requestId: refused.headers.get("X-Request-Id"),
    endpointRequestId: trace,
    step: "endpoint_health",
    reason: "transport",
    guard: "upstream_dispatch",
    cause: "Error",
  });
});

test("a re-send refused again before its own send stays the one request, with no second record", async (context) => {
  const h = await forwarding(context);
  const logged = context.mock.method(console, "error", () => {});
  const attempt = "4f3e2d1c-0b9a-4876-9543-210fedcba987";
  const refused = await h.send(await h.call({ [attemptHeader]: attempt }), async () => {
    throw new Error("protection refused before the send");
  });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get(mark), "1");
  assert.equal(refused.headers.get("X-Request-Id"), attempt);
  await refused.text();
  await h.settle();
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.finishes, []);
  const lines = logged.mock.calls.filter((call) => call.arguments[0] === "POOL_CONTROLLER_UNSENT");
  assert.equal(lines.length, 1);
  // Refused outside the runtime, the line still says where: the forward's guard and cause.
  assert.deepEqual(JSON.parse(String(lines[0]!.arguments[1])), {
    requestId: attempt,
    endpointRequestId: null,
    step: null,
    reason: null,
    guard: "runtime_port",
    cause: "Error",
    resent: true,
  });
});

test("a re-send whose client has left adds no record either", async (context) => {
  const h = await forwarding(context);
  const logged = context.mock.method(console, "error", () => {});
  const attempt = "6a5b4c3d-2e1f-4a9b-8c7d-6e5f4a3b2c1d";
  const left = new AbortController();
  left.abort();
  const request = new Request(await h.call({ [attemptHeader]: attempt }), {
    signal: left.signal,
  });
  const refused = await h.send(request, async () => {
    throw new Error("protection refused before the send");
  });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get(mark), "1");
  assert.equal(refused.headers.get("X-Request-Id"), attempt);
  await refused.text();
  await h.settle();
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.finishes, []);
  assert.equal(
    logged.mock.calls.filter((call) => call.arguments[0] === "POOL_CONTROLLER_UNSENT").length,
    1,
  );
  assert.equal(
    logged.mock.calls.filter((call) => call.arguments[0] === "POOL_GATEWAY_FAILURE").length,
    0,
  );
});

test("a call the root's cap refused, then sent again under its own name, is recorded once", async (context) => {
  const h = await forwarding(context);
  const logged = context.mock.method(console, "error", () => {});
  // The fleet answers the cap's refusal without a send: no dispatch, so no terminal start.
  const capped: Route = async (request) => rootFallbackRefused(request);
  const refused = await h.send(await h.call(), capped);
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get(mark), "1");
  const attempt = refused.headers.get("X-Request-Id");
  assert.ok(attempt);
  await refused.text();
  await h.settle();
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.finishes, []);
  // The entry sends it again under the refused attempt's id; the cap refuses once more, then serves.
  const again = await h.send(await h.call({ [attemptHeader]: attempt }), capped);
  assert.equal(again.headers.get("X-Request-Id"), attempt);
  await again.text();
  const answered = await h.send(await h.call({ [attemptHeader]: attempt }), nodeAnswer);
  assert.equal(answered.status, 200);
  await answered.text();
  await h.settle();
  assert.deepEqual(h.finishes, [{ id: attempt, outcome: "complete", status: 200 }]);
  const lines = logged.mock.calls.filter(
    (call) => call.arguments[0] === "POOL_ROOT_FALLBACK_REFUSED",
  );
  assert.deepEqual(
    lines.map((line) => JSON.parse(String(line.arguments[1])).requestId),
    [attempt, attempt],
    "every refused attempt of the one call carries its one id",
  );
});
