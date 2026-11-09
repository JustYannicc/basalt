import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeMemberships } from "./membership.ts";
import {
  membershipGraceMs,
  policyPrefix,
  type NativeMembershipPolicy,
} from "./membership-contract.ts";
import { installNativePolicy } from "./native-policy-install.ts";
import { openEnvelope } from "./token.ts";

const signingKey = "18".repeat(32);
const basePolicy: NativeMembershipPolicy = {
  pool: "lease-pool",
  organization: "lease-organization",
  revision: 1,
  expiresAt: 0,
  accounts: [],
  dirty: false,
};

function fixture(behindMs = 0, installMs = 0) {
  let now = 1_000_000;
  let installed: NativeMembershipPolicy | undefined;
  const values = new Map<string, unknown>();
  const alarms: number[] = [];
  const container = {
    getTcpPort: () => ({
      fetch: async (_input: string, init: RequestInit) => {
        const { projection } = JSON.parse(String(init.body)) as { projection: string };
        const policy = (await openEnvelope(
          signingKey,
          policyPrefix,
          projection,
        )) as NativeMembershipPolicy;
        assert.ok(policy, "the runtime receives a verifiable signed projection");
        const previous = installed;
        now += installMs;
        if (previous && !previous.dirty)
          assert.ok(
            now + 3_000 <= previous.expiresAt,
            "renewal leaves at least three seconds on the previous lease",
          );
        // This adapter keeps the existing native protocol's strict 15-second acceptance window.
        const remaining = policy.expiresAt - (now - behindMs);
        if (remaining <= 0 || remaining > 15_000)
          return Response.json(
            { error: "invalid_projection", reason: "lease_window", leaseMs: remaining },
            { status: 400 },
          );
        installed = policy;
        return Response.json({ installed: true, revision: policy.revision });
      },
    }),
  };
  const install = (policy: NativeMembershipPolicy) =>
    installNativePolicy(container, { signingKey, managementKey: "synthetic-management" }, policy);
  const memberships = new NativeMemberships({
    storage: {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    },
    signingKey,
    now: () => now,
    read: async (pool, organization) => ({ pool, organization, native: true, accounts: [] }),
    actual: async () => [],
    reconcile: async () => {},
    install,
    abort: () => {},
    schedule: async (at) => {
      alarms.push(at);
    },
  });
  return {
    memberships,
    install,
    alarms,
    now: () => now,
    advanceTo: (at: number) => {
      now = at;
    },
  };
}

test("a native clock 50 ms behind rejects the old full-window lease and accepts the issued lease", async () => {
  const f = fixture(50);
  await assert.rejects(f.install({ ...basePolicy, expiresAt: f.now() + 15_000 }));
  await f.memberships.ensure(basePolicy.pool, basePolicy.organization);
  assert.equal((await f.memberships.authority(basePolicy.pool))?.dirty, false);
});

test("an expired signed projection is still refused", async () => {
  const f = fixture();
  await assert.rejects(f.install({ ...basePolicy, expiresAt: f.now() }));
});

test("a signed projection one millisecond beyond the native 15-second maximum is still refused", async () => {
  const f = fixture();
  await assert.rejects(f.install({ ...basePolicy, expiresAt: f.now() + 15_001 }));
});

test("five-second upkeep keeps its renewal margin and acknowledged clean-cache grace", async () => {
  const f = fixture(50, 2_000);
  await f.memberships.ensure(basePolicy.pool, basePolicy.organization);
  for (let pass = 0; pass < 3; pass++) {
    f.advanceTo(f.alarms.at(-1)!);
    await f.memberships.tick();
    assert.equal((await f.memberships.authority(basePolicy.pool))?.dirty, false);
  }
  const policy = await f.memberships.authority(basePolicy.pool);
  assert.ok(policy);
  f.advanceTo(policy.expiresAt);
  assert.equal((await f.memberships.authority(basePolicy.pool))?.expiresAt, policy.expiresAt);
  f.advanceTo(policy.expiresAt + membershipGraceMs);
  await assert.rejects(f.memberships.authority(basePolicy.pool), /refreshing/);
});
