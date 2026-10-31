import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeMemberships } from "./membership.ts";
import { membershipPrefix, membershipTtlMs, type NativeMembershipPolicy, type NativeMembershipSnapshot } from "./membership-contract.ts";
import { signEnvelope } from "./token.ts";

const key = "3a".repeat(32);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let now = 1_000_000;
  const values = new Map<string, unknown>();
  const native = new Map<string, string[]>([["a", ["auth-a"]], ["b", ["auth-b"]]]);
  const home = new Map<string, string[]>();
  const installed = new Map<string, NativeMembershipPolicy>();
  const aborted: string[] = [], alarms: number[] = [];
  const snapshots = async (pool: string, organization: string): Promise<NativeMembershipSnapshot> => ({
    pool, organization, native: true, accounts: (native.get(pool) ?? []).map((id) => ({
      account: `account-${id}`, requirement: "openai", provider: "OpenAI", method: "chatgpt", generation: 1,
      driver: "basalt-home", driverRevision: "1", bindingRevision: "1", homeReference: id,
    })),
  });
  const deps = {
    storage: {
      get: async <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
      put: async (name: string, value: unknown) => { values.set(name, structuredClone(value)); },
    },
    signingKey: key, now: () => now, read: snapshots,
    actual: async (pool: string) => home.get(pool) ?? [],
    reconcile: async (pool: string, accounts: readonly string[]) => { home.set(pool, [...accounts]); },
    install: async (policy: NativeMembershipPolicy) => { installed.set(policy.pool, policy); },
    abort: (pool: string) => { aborted.push(pool); },
    schedule: async (at: number) => { alarms.push(at); },
  };
  const request = async (pool = "a", secret = key) => new Request("https://pool/pool/v1/membership", {
    method: "POST", body: JSON.stringify({ envelope: await signEnvelope(secret, membershipPrefix, {
      pool, organization: "org", at: now, expiresAt: now + 30_000,
    }) }),
  });
  return { deps, native, home, installed, aborted, alarms, request, advance: (ms: number) => { now += ms; } };
}

test("signed reservation persists refusal and aborts only that pool before acknowledging the writer", async () => {
  const f = fixture(), memberships = new NativeMemberships(f.deps);
  await assert.rejects(memberships.reserve(await f.request("a", "4b".repeat(32))));
  assert.equal(await memberships.configured(), false);
  await memberships.reserve(await f.request());
  assert.deepEqual(f.aborted, ["a"]);
  assert.equal(f.installed.get("a")?.dirty, true);
  await assert.rejects(memberships.authority("a"), /refreshing/);
  assert.equal(await memberships.authority("b"), undefined);
  assert.equal(f.alarms.length, 1);
});

test("failed local acknowledgement keeps authority dirty and rollback converges to current links", async () => {
  const f = fixture();
  const install = f.deps.install;
  f.deps.install = async () => { throw new Error("plugin unavailable"); };
  const memberships = new NativeMemberships(f.deps);
  await assert.rejects(memberships.reserve(await f.request()), /plugin unavailable/);
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.deps.install = install;
  await memberships.tick();
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a"]);
  assert.deepEqual(f.home.get("a"), ["auth-a"]);
});

test("level repair removes a late stale attach on every pass and after controller restart", async () => {
  const f = fixture();
  let memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  f.home.set("a", ["auth-a", "revoked"]);
  memberships = new NativeMemberships(f.deps);
  await memberships.tick();
  assert.deepEqual(f.home.get("a"), ["auth-a"]);
  assert.equal((await memberships.authority("a"))?.dirty, false);
});

test("a reserve during an old read prevents that read from re-enabling use", async () => {
  const f = fixture(), memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  const entered = deferred<void>(), finish = deferred<NativeMembershipSnapshot>();
  const read = f.deps.read;
  f.deps.read = async () => { entered.resolve(); return finish.promise; };
  const old = memberships.refresh("a");
  await entered.promise;
  await memberships.reserve(await f.request());
  const reserved = f.installed.get("a")!;
  f.native.set("a", []);
  finish.resolve(await read("a", "org"));
  await old;
  assert.equal(f.installed.get("a"), reserved);
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.deps.read = read;
  await memberships.tick();
  assert.deepEqual((await memberships.authority("a"))?.accounts, []);
  assert.deepEqual(f.home.get("a"), []);
});

test("a missing current Home binding fails closed while the other pool remains usable", async () => {
  const f = fixture(), memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request("a"));
  await memberships.reserve(await f.request("b"));
  await memberships.tick();
  const read = f.deps.read;
  f.deps.read = async (pool, organization) => {
    const result = await read(pool, organization);
    return pool === "a" ? { ...result, accounts: result.accounts.map((account) => ({ ...account, homeReference: null })) } : result;
  };
  await memberships.tick();
  await assert.rejects(memberships.authority("a"), /refreshing/);
  assert.deepEqual((await memberships.authority("b"))?.accounts, ["auth-b"]);
});

test("authority expires when the native read fails and recovers on the next successful level read", async () => {
  const f = fixture(), memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  const read = f.deps.read;
  f.deps.read = async () => { throw new Error("tools down"); };
  f.advance(membershipTtlMs);
  await memberships.tick();
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.deps.read = read;
  await memberships.tick();
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a"]);
});

test("authority requires the exact clean policy acknowledgement and never extends a failed renewal", async () => {
  const f = fixture(), memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  const install = f.deps.install;
  f.deps.install = async () => { throw new Error("local install failed"); };
  await memberships.tick();
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.deps.install = install;
  await memberships.tick();
  const accepted = await memberships.authority("a");
  assert.ok(accepted);
  assert.deepEqual(Object.keys(accepted).sort(), ["accounts", "dirty", "expiresAt", "organization", "pool", "revision"]);
  f.advance(5_000);
  f.deps.install = async () => { throw new Error("renewal failed"); };
  await memberships.tick();
  assert.ok(await memberships.authority("a"), "the previous acknowledged policy is still inside its lease");
  f.advance(membershipTtlMs - 5_000);
  await assert.rejects(memberships.authority("a"), /refreshing/);
});
