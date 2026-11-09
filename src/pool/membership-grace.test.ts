import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeMemberships } from "./membership.ts";
import { installNativePolicy } from "./native-policy-install.ts";
import { modelMembership } from "./model-membership.ts";
import {
  membershipPrefix,
  membershipTtlMs,
  policyHeader,
  policyPrefix,
  policyUsePrefix,
  type NativeMembershipPolicy,
  type NativeMembershipSnapshot,
} from "./membership-contract.ts";
import { openEnvelope, signEnvelope } from "./token.ts";

const key = "7c".repeat(32);
const graceMs = 24 * 60 * 60_000;

function fixture() {
  let now = Date.now();
  let fault: "none" | "install400" | "read" | "reconcile" = "none";
  let selected = ["saved-account"];
  let native = true;
  let installed: NativeMembershipPolicy | undefined;
  const stored = new Map<string, unknown>();
  const aborted: string[] = [];
  const container = {
    getTcpPort: () => ({
      fetch: async (_input: string, init: RequestInit) => {
        if (fault === "install400")
          return Response.json({ error: "invalid_projection" }, { status: 400 });
        const { projection } = JSON.parse(String(init.body)) as { projection: string };
        installed = (await openEnvelope(key, policyPrefix, projection)) as NativeMembershipPolicy;
        return Response.json({ installed: true, revision: installed.revision });
      },
    }),
  };
  const dependencies = {
    storage: {
      get: async <T>(name: string) => structuredClone(stored.get(name)) as T | undefined,
      put: async (name: string, value: unknown) => {
        stored.set(name, structuredClone(value));
      },
    },
    signingKey: key,
    now: () => now,
    read: async (pool: string, organization: string): Promise<NativeMembershipSnapshot> => {
      if (fault === "read") throw new Error("control plane unavailable");
      return {
        pool,
        organization,
        native,
        accounts: selected.map((homeReference) => ({
          account: homeReference,
          requirement: "subscriptions",
          provider: "codex",
          method: "codex",
          generation: 1,
          driver: "basalt-home",
          driverRevision: "1",
          bindingRevision: "1",
          homeReference,
        })),
      };
    },
    actual: async () => selected,
    reconcile: async () => {
      if (fault === "reconcile") throw new Error("Home unavailable");
    },
    install: (policy: NativeMembershipPolicy) =>
      installNativePolicy(container, { signingKey: key, managementKey: "fixture-only" }, policy),
    abort: (pool: string) => {
      aborted.push(pool);
    },
    schedule: async () => {},
  };
  return {
    dependencies,
    aborted,
    installed: () => installed,
    fault: (value: typeof fault) => {
      fault = value;
    },
    select: (value: string[]) => {
      selected = value;
    },
    native: (value: boolean) => {
      native = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    reserve: async (memberships: NativeMemberships) =>
      memberships.reserve(
        new Request("https://pool.invalid/pool/v1/membership", {
          method: "POST",
          body: JSON.stringify({
            envelope: await signEnvelope(key, membershipPrefix, {
              pool: "pool",
              organization: "organization",
              at: now,
              expiresAt: now + 30_000,
            }),
          }),
        }),
      ),
  };
}

for (const fault of ["install400", "read", "reconcile"] as const)
  test(`${fault} keeps the last acknowledged model policy through a two-hour outage, never beyond 24-hour grace`, async () => {
    const f = fixture();
    const memberships = new NativeMemberships(f.dependencies);
    await memberships.ensure("pool", "organization");
    const accepted = await memberships.authority("pool");
    assert.ok(accepted);
    f.fault(fault);
    f.advance(membershipTtlMs + 2 * 60 * 60_000);
    await memberships.ensure("pool", "organization");
    assert.deepEqual(await memberships.authority("pool"), accepted);
    const gate = await modelMembership(
      new Request("https://pool.invalid/v1/models"),
      memberships,
      key,
      undefined,
      { pool: "pool", person: "person" },
    );
    const assertion = await openEnvelope(
      key,
      policyUsePrefix,
      gate.request.headers.get(policyHeader)!,
    );
    assert.equal((assertion as { revision: number }).revision, accepted.revision);
    assert.deepEqual(f.installed()?.accounts, ["saved-account"]);
    f.advance(graceMs - 2 * 60 * 60_000 - 1);
    await memberships.tick();
    assert.deepEqual(await memberships.authority("pool"), accepted);
    f.advance(1);
    await assert.rejects(memberships.ensure("pool", "organization"));
    await assert.rejects(memberships.authority("pool"), /refreshing/);
    await assert.rejects(
      modelMembership(new Request("https://pool.invalid/v1/models"), memberships, key, undefined, {
        pool: "pool",
        person: "person",
      }),
      /unavailable/,
    );
    f.fault("none");
    await memberships.ensure("pool", "organization");
    assert.deepEqual((await memberships.authority("pool"))?.accounts, ["saved-account"]);
  });

test("a reservation durably revokes grace even if its dirty policy install returns 400", async () => {
  const f = fixture();
  let memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  f.fault("install400");
  f.advance(membershipTtlMs + 1);
  await memberships.ensure("pool", "organization");
  await assert.rejects(f.reserve(memberships));
  assert.equal(f.aborted.at(-1), "pool");
  await assert.rejects(memberships.authority("pool"), /refreshing/);
  memberships = new NativeMemberships(f.dependencies);
  await assert.rejects(memberships.authority("pool"), /refreshing/);
  await assert.rejects(memberships.ensure("pool", "organization"));
  f.select([]);
  f.fault("none");
  await memberships.ensure("pool", "organization");
  assert.deepEqual((await memberships.authority("pool"))?.accounts, []);
});

for (const change of ["removed", "replaced", "not-native"] as const)
  test(`observed ${change} membership cannot reuse grace when reconciliation or installation fails`, async () => {
    const f = fixture();
    const memberships = new NativeMemberships(f.dependencies);
    await memberships.ensure("pool", "organization");
    if (change === "not-native") f.native(false);
    else f.select(change === "removed" ? [] : ["replacement"]);
    f.fault(change === "not-native" ? "install400" : "reconcile");
    f.advance(membershipTtlMs + 1);
    await assert.rejects(memberships.ensure("pool", "organization"));
    assert.equal(f.aborted.at(-1), "pool");
    await assert.rejects(memberships.authority("pool"), /refreshing/);
  });

test("a failed first clean installation never creates last-known-good authority", async () => {
  const f = fixture();
  const memberships = new NativeMemberships(f.dependencies);
  f.fault("install400");
  await assert.rejects(memberships.ensure("pool", "organization"));
  await assert.rejects(memberships.authority("pool"), /refreshing/);
});

test("last acknowledged grace survives controller reactivation without extending its deadline", async () => {
  const f = fixture();
  let memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  const accepted = await memberships.authority("pool");
  f.fault("install400");
  f.advance(membershipTtlMs + graceMs - 1);
  memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  assert.deepEqual(await memberships.authority("pool"), accepted);
  f.advance(1);
  await assert.rejects(memberships.authority("pool"), /refreshing/);
});

test("retained records without a grace acknowledgement cannot gain grace during an outage", async () => {
  const f = fixture();
  const memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  const name = "native-pool-memberships-v1";
  const retained =
    await f.dependencies.storage.get<Record<string, { installedGraceUntil?: number }>>(name);
  assert.ok(retained?.pool);
  delete retained.pool.installedGraceUntil;
  await f.dependencies.storage.put(name, retained);
  assert.ok(await memberships.authority("pool"));
  f.fault("install400");
  f.advance(membershipTtlMs);
  await assert.rejects(memberships.ensure("pool", "organization"));
  await assert.rejects(memberships.authority("pool"), /refreshing/);
});
