import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeMemberships } from "./membership.ts";
import {
  membershipPrefix,
  membershipReadMs,
  membershipRefreshMs,
  type NativeMembershipPolicy,
  type NativeMembershipSnapshot,
} from "./membership-contract.ts";
import { signEnvelope } from "./token.ts";

const key = "5c".repeat(32);
const hourMs = 60 * 60_000;

/** Counts every host read and Home call. Its runtime keeps the native install rules. */
function fixture(accounts: Record<string, string[] | "not-native">) {
  let now = 1_000_000;
  const host = new Map(Object.entries(accounts));
  const values = new Map<string, unknown>();
  const home = new Map<string, string[]>();
  const runtime = new Map<string, NativeMembershipPolicy>();
  const calls = { reads: [] as string[], home: 0, installs: 0 };
  let failRead = false;
  const deps: ConstructorParameters<typeof NativeMemberships>[0] = {
    storage: {
      get: async <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
      put: async (name: string, value: unknown) => {
        values.set(name, structuredClone(value));
      },
    },
    signingKey: key,
    now: () => now,
    read: async (pool, organization): Promise<NativeMembershipSnapshot> => {
      calls.reads.push(pool);
      if (failRead) throw new Error("tools unavailable");
      const selected = host.get(pool) ?? "not-native";
      if (selected === "not-native") return { pool, organization, native: false, accounts: [] };
      return {
        pool,
        organization,
        native: true,
        accounts: selected.map((id) => ({
          account: `account-${id}`,
          requirement: "openai",
          provider: "OpenAI",
          method: "chatgpt",
          generation: 1,
          driver: "basalt-home",
          driverRevision: "1",
          bindingRevision: "1",
          homeReference: id,
        })),
      };
    },
    actual: async (pool) => {
      calls.home++;
      return home.get(pool) ?? [];
    },
    reconcile: async (pool, selected) => {
      calls.home++;
      home.set(pool, [...selected]);
    },
    install: async (policy) => {
      calls.installs++;
      // The native scheduler refuses an older revision and a same-revision lease that ends earlier.
      const current = runtime.get(policy.pool);
      if (
        current &&
        (policy.revision < current.revision ||
          (policy.revision === current.revision && policy.expiresAt < current.expiresAt))
      )
        throw new Error("stale or conflicting projection");
      runtime.set(policy.pool, policy);
    },
    abort: () => {},
    schedule: async () => {},
  };
  let memberships = new NativeMemberships(deps);
  const reserve = async (pool: string) =>
    memberships.reserve(
      new Request("https://pool/pool/v1/membership", {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(key, membershipPrefix, {
            pool,
            organization: "org",
            at: now,
            expiresAt: now + 30_000,
          }),
        }),
      }),
    );
  /** The model gate's view: which accounts the pool may use right now. */
  const usable = async (pool: string) =>
    (await memberships.authority(pool).catch(() => undefined))?.accounts ?? [];
  const reset = () => {
    calls.reads.length = 0;
    calls.home = 0;
    calls.installs = 0;
  };
  return {
    get memberships() {
      return memberships;
    },
    restart: () => {
      memberships = new NativeMemberships(deps);
    },
    host,
    runtime,
    calls,
    reserve,
    usable,
    reset,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    failReads: (value: boolean) => {
      failRead = value;
    },
  };
}

async function setUp(accounts: Record<string, string[] | "not-native">) {
  const f = fixture(accounts);
  for (const pool of Object.keys(accounts)) await f.reserve(pool);
  await f.memberships.tick();
  f.reset();
  return f;
}

test("an idle hour reads each pool once a minute instead of on every five-second pass", async () => {
  // Six clean native pools and one the host no longer registers as native.
  const pools = Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((index) => [`pool-${index}`, [`auth-${index}`]]),
  );
  const f = await setUp({ ...pools, "pool-7": "not-native" });
  const passes = hourMs / membershipRefreshMs;
  for (let pass = 0; pass < passes; pass++) {
    f.advance(membershipRefreshMs);
    await f.memberships.tick();
  }
  // Before this change every pass read every pool and called Home twice per native pool:
  // 720 passes x 7 pools = 5,040 host reads and 720 x 6 x 2 = 8,640 Home calls an hour.
  assert.equal(f.calls.reads.length, 7 * (hourMs / membershipReadMs), "420 host reads");
  assert.equal(f.calls.home, 6 * 2 * (hourMs / membershipReadMs), "720 Home calls");
  // Native policy leases still renew on every pass.
  assert.equal(f.calls.installs, 7 * passes);
  for (const index of [1, 2, 3, 4, 5, 6])
    assert.deepEqual(await f.usable(`pool-${index}`), [`auth-${index}`]);
});

test("a removal through the host is refused before it commits, and any other change within one read interval", async () => {
  const f = await setUp({ pool: ["kept", "removed"] });
  // Through the host: its reservation vetoes the pool before the removal transaction may commit.
  f.host.set("pool", ["kept"]);
  await f.reserve("pool");
  assert.deepEqual(await f.usable("pool"), [], "no account is usable until the committed read");
  assert.equal(f.runtime.get("pool")?.dirty, true);
  await f.memberships.tick();
  assert.deepEqual(f.calls.reads, ["pool"], "the reservation is read on the next pass");
  assert.deepEqual(await f.usable("pool"), ["kept"]);
  assert.deepEqual(f.runtime.get("pool")?.accounts, ["kept"]);

  // Bypassing the host's hooks: seen at the first pass at least one read interval after the last read.
  f.host.set("pool", ["kept", "removed"]);
  await f.reserve("pool");
  await f.memberships.tick();
  const lastRead = f.now();
  f.advance(1_234);
  f.host.set("pool", ["kept"]);
  const removedAt = f.now();
  let lostAt: number | undefined;
  while (lostAt === undefined) {
    f.advance(membershipRefreshMs);
    await f.memberships.tick();
    if (!f.runtime.get("pool")?.accounts.includes("removed")) lostAt = f.now();
    else assert.ok(f.now() - lastRead < membershipReadMs, "kept only inside the read interval");
  }
  assert.deepEqual(await f.usable("pool"), ["kept"]);
  assert.ok(
    lostAt - removedAt <= membershipReadMs + membershipRefreshMs,
    `bound is one read interval plus one pass, got ${lostAt - removedAt} ms`,
  );
});

test("a reservation reads only its own pool", async () => {
  const f = await setUp({ a: ["auth-a"], b: ["auth-b"], c: ["auth-c"] });
  f.host.set("b", []);
  await f.reserve("b");
  await f.memberships.tick();
  assert.deepEqual(f.calls.reads, ["b"]);
  assert.deepEqual(await f.usable("b"), []);
  assert.deepEqual(await f.usable("a"), ["auth-a"]);
});

test("a failed host read retries on the next pass, not after the read interval", async () => {
  const f = await setUp({ pool: ["auth"] });
  f.advance(membershipReadMs);
  f.failReads(true);
  await f.memberships.tick();
  assert.deepEqual(f.calls.reads, ["pool"]);
  f.failReads(false);
  f.advance(membershipRefreshMs);
  await f.memberships.tick();
  assert.deepEqual(f.calls.reads, ["pool", "pool"]);
  f.advance(membershipRefreshMs);
  await f.memberships.tick();
  assert.equal(f.calls.reads.length, 2, "a successful read restores the slow interval");
});

test("a failed renewal reads the host on the next pass", async () => {
  const f = await setUp({ pool: ["auth"] });
  // A runtime that already holds a later lease refuses this renewal.
  f.runtime.set("pool", { ...f.runtime.get("pool")!, expiresAt: f.now() + 60_000 });
  f.advance(membershipRefreshMs);
  await f.memberships.tick();
  assert.deepEqual(f.calls.reads, []);
  f.advance(membershipRefreshMs);
  await f.memberships.tick();
  assert.deepEqual(f.calls.reads, ["pool"]);
});

test("a restarted controller reads every pool on its first pass", async () => {
  const f = await setUp({ a: ["auth-a"], b: ["auth-b"] });
  f.restart();
  f.advance(membershipRefreshMs);
  await f.memberships.tick();
  assert.deepEqual(f.calls.reads.sort(), ["a", "b"]);
  f.advance(membershipRefreshMs);
  await f.memberships.tick();
  assert.equal(f.calls.reads.length, 2);
});
