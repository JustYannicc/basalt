import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeDatabasePoolMonitor, homeDatabasePool } from "./home-database-pool.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { NativeStreams } from "./native-streams.ts";
import { RuntimeProtection } from "./runtime-protection.ts";
import { runtimeFailureHeaders } from "./runtime-route-diagnostic.ts";
import { PoolDependencyFailure } from "./dependency-failure.ts";

// Home `GET /capabilities` with carry 0284: every connection taken and callers queued behind them.
const saturated = {
  capabilities: { usage_token_breakdown_v2: true },
  server_info: {
    home_version: "v1.1.6",
    database_pool: {
      max_open_connections: 6,
      open_connections: 6,
      in_use: 6,
      idle: 0,
      wait_count: 1_843,
      wait_duration_ns: 912_000_000_000,
      max_idle_closed: 0,
      max_idle_time_closed: 4,
      max_lifetime_closed: 2,
    },
  },
};

test("Home's pool counters are read from server_info and anything else is absent", () => {
  assert.deepEqual(homeDatabasePool(saturated), {
    inUse: 6,
    waitCount: 1_843,
    waitDurationNs: 912_000_000_000,
  });
  for (const value of [
    {},
    { server_info: { database_pool: null } },
    { server_info: { database_pool: { in_use: 6, wait_count: 1 } } },
    { server_info: { database_pool: { in_use: -1, wait_count: 1, wait_duration_ns: 1 } } },
    { server_info: { database_pool: { in_use: "6", wait_count: 1, wait_duration_ns: 1 } } },
    null,
  ])
    assert.equal(homeDatabasePool(value), undefined);
});

test("the monitor reads Home once a minute, keeps the last value on failure and never wedges", async () => {
  let now = 1_000_000;
  let reads = 0;
  let answer: () => Promise<unknown> = async () => saturated;
  const monitor = new HomeDatabasePoolMonitor(
    () => {
      reads++;
      return answer();
    },
    () => now,
  );
  const reports: unknown[] = [];
  const record = (observation: unknown) => reports.push(observation);
  assert.equal(monitor.observation(), null);
  now += 59_999;
  await monitor.report(record);
  assert.equal(reads, 0, "a fresh controller does not read Home before one full interval");
  now += 1;
  await Promise.all([monitor.report(record), monitor.report(record)]);
  assert.equal(reads, 1);
  assert.deepEqual(reports, [
    { inUse: 6, waitCount: 1_843, waitDurationNs: 912_000_000_000, ageMs: 0 },
  ]);
  now += 1_500;
  assert.equal(monitor.observation()?.ageMs, 1_500);

  answer = async () => {
    throw new Error("refused while readiness is degraded");
  };
  now += 60_000;
  await monitor.report(record);
  assert.equal(reads, 2);
  assert.equal(monitor.observation()?.ageMs, 61_500, "a failed read keeps the last counters");

  // A read that ignores its signal still settles at the two-second bound.
  answer = () => new Promise(() => {});
  now += 60_000;
  const started = performance.now();
  await monitor.report(record);
  assert.ok(performance.now() - started < 2_500);
  answer = async () => saturated;
  now += 60_000;
  await monitor.report(record);
  assert.equal(reads, 4, "the stuck read did not block the next minute's read");
  assert.equal(monitor.observation()?.ageMs, 0);
});

test("a refused request logs Home's last pool counters without reading Home", async (context) => {
  const log = context.mock.method(console, "error", () => {});
  const streams = new NativeStreams();
  const never = async (): Promise<never> => {
    throw new Error("Unexpected operation");
  };
  const observation = { inUse: 6, waitCount: 1_843, waitDurationNs: 912_000_000_000, ageMs: 400 };
  const deferred: Promise<unknown>[] = [];
  let route: () => Promise<Response> = async () => {
    throw new PoolRuntimeUnhealthy();
  };
  const deps = {
    env: { POOL_APP_SIGNING_KEY: "fixture-signing-key" },
    computers: { nativeModel: never, observeUsage: async () => {} },
    memberships: {},
    streams,
    lifecycle: Promise.resolve({ warm: never }),
    protection: new RuntimeProtection(streams, {
      check: never,
      defer: () => {},
      unavailable: () => {},
    }),
    databasePool: { observation: () => observation },
    route: () => route(),
    fetch: never,
    defer: (work: Promise<unknown>) => deferred.push(work),
  };
  const module = "./forward.worker.ts";
  const {
    forwardPoolRequest,
  }: {
    forwardPoolRequest(request: Request, port: 8327, dependencies: typeof deps): Promise<Response>;
  } = await import(module);
  const refused = await forwardPoolRequest(
    new Request("https://pool.example/v8/management/usage"),
    8327,
    deps,
  );
  assert.equal(refused.status, 503);
  const gateway = log.mock.calls.find((call) => call.arguments[0] === "POOL_GATEWAY_FAILURE");
  assert.deepEqual(gateway?.arguments[1].homeDatabasePool, observation);
  assert.equal(gateway?.arguments[1].guard, "runtime_port");

  route = async () =>
    new Response(null, {
      status: 503,
      headers: runtimeFailureHeaders(
        new PoolDependencyFailure("membership", new Error("private-dependency")),
        "fleet_forward",
      ),
    });
  const relayed = await forwardPoolRequest(
    new Request("https://pool.example/v8/management/usage"),
    8327,
    deps,
  );
  assert.equal(relayed.status, 503);
  const routed = log.mock.calls.find((call) => call.arguments[0] === "POOL_RUNTIME_ROUTE_FAILURE");
  assert.deepEqual(routed?.arguments[1].homeDatabasePool, observation);
  assert.equal(routed?.arguments[1].runtimeCause, "dependency_membership");
  for (const header of ["Step", "Reason", "Cause"])
    assert.equal(relayed.headers.get(`X-Signalbox-Runtime-Failure-${header}`), null);
  await Promise.all(deferred);
});
