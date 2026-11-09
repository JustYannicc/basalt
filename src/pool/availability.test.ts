import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitProbe, probePool } from "./availability.ts";
import { validProbeTarget } from "./availability-config.ts";
import { availabilityRuntime } from "./availability-runtime.ts";
import { NativeMemberships } from "./membership.ts";
import { object, unavailable } from "./json.ts";
import { membershipPrefix } from "./membership-contract.ts";
import { poolGroupPrefix } from "./pool-group.ts";
import { openEnvelope, signEnvelope } from "./token.ts";

const signingKey = "3a".repeat(32);
const policy = {
  pool: "fixture-pool",
  organization: "fixture-org",
  revision: 4,
  accounts: ["auth-a"],
  native: true,
  dirty: false,
  expiresAt: 1015,
  installedRevision: 4,
  installedUntil: 1015,
};

test("the passive probe checks view and native guard even when runtime health fails", async () => {
  const calls: string[] = [];
  const result = await probePool(policy.pool, {
    now: () => 1000,
    runtime: async () => {
      calls.push("runtime");
      throw new Error("private endpoint secret");
    },
    view: async () => {
      calls.push("view");
      throw new Error("private response body");
    },
    membership: async () => ({ policy }),
    native: async () => {
      calls.push("guard");
    },
  });
  assert.deepEqual(calls.sort(), ["guard", "runtime", "view"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    { guard: "runtime", reason: "unavailable" },
    { guard: "pool_view", reason: "unavailable" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|endpoint|body/);
});

test("dirty, absent, unacknowledged and overdue authority cannot produce a healthy check", async () => {
  for (const [value, reason] of [
    [undefined, "missing"],
    [{ ...policy, dirty: true }, "dirty"],
    [{ ...policy, installedRevision: 3 }, "unacknowledged"],
    [{ ...policy, installedUntil: 1000 }, "renewal_overdue"],
  ] as const) {
    const result = await probePool(policy.pool, {
      now: () => 1000,
      runtime: async () => {},
      view: async () => {},
      membership: async () => ({ policy: value }),
      native: async () => {},
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.reason === reason));
  }
});

test("a renewal 400 is detected without retrying installation or mutating the retained acknowledgement", async () => {
  let now = 100_000;
  let rejectInstall = false;
  let writes = 0,
    installs = 0;
  const stored = new Map<string, unknown>();
  const memberships = new NativeMemberships({
    storage: {
      get: async <T>(name: string) => structuredClone(stored.get(name)) as T | undefined,
      put: async (name, value) => {
        writes++;
        stored.set(name, structuredClone(value));
      },
    },
    signingKey,
    now: () => now,
    read: async (pool, organization) => ({ pool, organization, native: true, accounts: [] }),
    actual: async () => [],
    reconcile: async () => {},
    abort: () => {},
    schedule: async () => {},
    install: async () => {
      installs++;
      if (rejectInstall)
        unavailable({
          guard: "native_policy_install",
          failure: "response_status",
          backendStatus: 400,
        });
    },
  });
  const envelope = await signEnvelope(signingKey, membershipPrefix, {
    pool: policy.pool,
    organization: policy.organization,
    at: now,
    expiresAt: now + 30_000,
  });
  await memberships.reserve(
    new Request("https://fixture/pool/v1/membership", {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
  );
  await memberships.refresh(policy.pool);
  rejectInstall = true;
  now += 60_000;
  await assert.rejects(memberships.refresh(policy.pool));
  const before = structuredClone([...stored]);
  const counts = { writes, installs };
  const result = await probePool(policy.pool, {
    now: () => now,
    runtime: async () => {},
    view: async () => {},
    membership: (pool) => memberships.inspect(pool),
    native: async () => {},
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some(
      (failure) => failure.guard === "native_policy_install" && failure.backendStatus === 400,
    ),
  );
  assert.ok(result.failures.some((failure) => failure.reason === "renewal_overdue"));
  assert.deepEqual([...stored], before);
  assert.deepEqual({ writes, installs }, counts);
  rejectInstall = false;
  await memberships.refresh(policy.pool);
  assert.equal(
    (
      await probePool(policy.pool, {
        now: () => now,
        runtime: async () => {},
        view: async () => {},
        membership: (pool) => memberships.inspect(pool),
        native: async () => {},
      })
    ).ok,
    true,
  );
});

test("runtime observations use direct GET views and an exact signed native check, never model dispatch", async () => {
  const calls: Array<{ port: number; method: string; path: string }> = [];
  const runtime = availabilityRuntime(
    {
      running: true,
      getTcpPort(port) {
        return {
          async fetch(input, init) {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            calls.push({ port, method: request.method, path });
            if (port === 8318 && path === "/ready") {
              assert.equal(request.headers.get("Authorization"), "Bearer management-fixture");
              return Response.json(
                { boot_id: "fixture-boot", started_at: "fixture-start" },
                { headers: { "X-Signalbox-Policy-Lease-Ms": "1500" } },
              );
            }
            if (port === 8318 && path === "/native-policy/check") {
              const { assertion } = await request.json();
              const claims = await openEnvelope(signingKey, "sbm-use1", assertion);
              assert.ok(object(claims));
              assert.equal(claims.pool, policy.pool);
              assert.equal(claims.revision, policy.revision);
              return Response.json({ ok: true });
            }
            assert.equal(port, 8327);
            assert.equal(request.method, "GET");
            assert.equal(request.headers.get("X-Management-Key"), "management-fixture");
            if (path === "/v8/management/channel-groups")
              return Response.json({
                channel_groups: [{ id: 1, channel_name: `${poolGroupPrefix}${policy.pool}` }],
              });
            if (path === "/v8/management/channel-group-details")
              return Response.json({
                channel_group_details: [{ id: 1, channel_group_id: 1, auth_id: "auth-a" }],
              });
            if (path === "/v8/management/credentials")
              return Response.json({
                files: [{ id: "auth-a", provider: "openai", disabled: false }],
              });
            if (path === "/v8/management/quota/credentials/auth-a")
              return Response.json({ credential: { credential_id: "auth-a" }, windows: [] });
            throw new Error(`Unexpected read ${path}`);
          },
        };
      },
    },
    "management-fixture",
    signingKey,
  );
  const signal = new AbortController().signal;
  await runtime.runtime(signal);
  await runtime.view(policy.pool, signal);
  await runtime.native(policy, signal);
  assert.ok(calls.some((call) => call.path === "/native-policy/check"));
  assert.ok(calls.some((call) => call.path === "/v8/management/credentials"));
  assert.ok(calls.some((call) => call.path === "/v8/management/quota/credentials/auth-a"));
  assert.ok(calls.every((call) => call.method === "GET" || call.path === "/native-policy/check"));
});

test("stopped runtimes are observed without opening ports or starting compute", async () => {
  const runtime = availabilityRuntime(
    {
      running: false,
      getTcpPort() {
        throw new Error("must not open a port");
      },
    },
    "key",
    signingKey,
  );
  await assert.rejects(runtime.runtime(new AbortController().signal), /stopped/);
  await assert.rejects(runtime.view(policy.pool, new AbortController().signal));
});

test("a hung observation is cancelled at its supplied deadline without waiting on its dependency", async () => {
  const controller = new AbortController();
  const pending = awaitProbe(() => new Promise<never>(() => {}), controller.signal);
  controller.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(pending, { name: "TimeoutError" });
  let started = false;
  await assert.rejects(
    awaitProbe(async () => {
      started = true;
    }, controller.signal),
  );
  assert.equal(started, false);
});

test("invalid target configuration never dispatches reads", async () => {
  assert.equal(validProbeTarget("fixture-pool"), true);
  for (const target of ["", "private@example.invalid", "../pool", "pool\nsecret"]) {
    assert.equal(validProbeTarget(target), false);
    const unexpected = async (): Promise<never> => {
      throw new Error("must not read");
    };
    assert.deepEqual(
      await probePool(target, {
        runtime: unexpected,
        view: unexpected,
        membership: unexpected,
        native: unexpected,
      }),
      { ok: false, failures: [{ guard: "configuration", reason: "invalid_target" }] },
    );
  }
});
