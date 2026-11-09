import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeMemberships } from "./membership.ts";
import {
  membershipPrefix,
  membershipTtlMs,
  membershipGraceMs,
  type NativeMembershipPolicy,
  type NativeMembershipSnapshot,
} from "./membership-contract.ts";
import { signEnvelope } from "./token.ts";

const key = "3a".repeat(32);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let now = 1_000_000;
  const values = new Map<string, unknown>();
  const native = new Map<string, string[]>([
    ["a", ["auth-a"]],
    ["b", ["auth-b"]],
  ]);
  const home = new Map<string, string[]>();
  const installed = new Map<string, NativeMembershipPolicy>();
  const aborted: string[] = [],
    alarms: number[] = [];
  const snapshots = async (
    pool: string,
    organization: string,
  ): Promise<NativeMembershipSnapshot> => ({
    pool,
    organization,
    native: true,
    accounts: (native.get(pool) ?? []).map((id) => ({
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
  });
  const deps = {
    storage: {
      get: async <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
      put: async (name: string, value: unknown) => {
        values.set(name, structuredClone(value));
      },
    },
    signingKey: key,
    now: () => now,
    read: snapshots,
    actual: async (pool: string) => home.get(pool) ?? [],
    reconcile: async (pool: string, accounts: readonly string[]) => {
      home.set(pool, [...accounts]);
    },
    install: async (policy: NativeMembershipPolicy) => {
      installed.set(policy.pool, policy);
    },
    abort: (pool: string) => {
      aborted.push(pool);
    },
    schedule: async (at: number) => {
      alarms.push(at);
    },
  };
  const request = async (pool = "a", secret = key) =>
    new Request("https://pool/pool/v1/membership", {
      method: "POST",
      body: JSON.stringify({
        envelope: await signEnvelope(secret, membershipPrefix, {
          pool,
          organization: "org",
          at: now,
          expiresAt: now + 30_000,
        }),
      }),
    });
  return {
    deps,
    native,
    home,
    installed,
    aborted,
    alarms,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("signed reservation persists refusal and aborts only that pool before acknowledging the writer", async () => {
  const f = fixture();
  const invalidated: string[] = [];
  const memberships = new NativeMemberships({
    ...f.deps,
    invalidateView: async (pool) => {
      invalidated.push(pool);
    },
  });
  await assert.rejects(memberships.reserve(await f.request("a", "4b".repeat(32))));
  assert.deepEqual(invalidated, []);
  assert.equal(await memberships.configured(), false);
  await memberships.reserve(await f.request());
  assert.deepEqual(invalidated, ["a"]);
  assert.deepEqual(f.aborted, ["a"]);
  assert.equal(f.installed.get("a")?.dirty, true);
  await assert.rejects(memberships.authority("a"), /refreshing/);
  assert.equal(await memberships.authority("b"), undefined);
  assert.equal(f.alarms.length, 1);
});

test("a retained Home read stays readable when an invalidation has no native host registration", async () => {
  const f = fixture();
  const memberships = new NativeMemberships({
    ...f.deps,
    read: async (pool, organization) => ({ pool, organization, native: false, accounts: [] }),
  });
  f.home.set("a", ["retained-home-account"]);
  await memberships.reserve(await f.request());
  await memberships.ensure("a", "org");
  assert.deepEqual(f.home.get("a"), ["retained-home-account"]);
  await assert.rejects(memberships.authority("a"), /refreshing/);
});

test("failed local acknowledgement keeps authority dirty and rollback converges to current links", async () => {
  const f = fixture();
  const install = f.deps.install;
  f.deps.install = async () => {
    throw new Error("plugin unavailable");
  };
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

test("overlapping ticks share one upkeep pass without postponing its alarm or stacking repairs", async () => {
  const f = fixture();
  const memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  f.alarms.length = 0;
  const entered = deferred<void>(),
    release = deferred<void>();
  const read = f.deps.read;
  let reads = 0;
  f.deps.read = async (pool, organization) => {
    reads++;
    entered.resolve();
    await release.promise;
    return read(pool, organization);
  };
  const first = memberships.tick();
  await entered.promise;
  const deadline = f.alarms[0];
  f.advance(13_800);
  const overlap = [memberships.tick(), memberships.tick()];
  release.resolve();
  await Promise.all([first, ...overlap]);
  assert.deepEqual(
    f.alarms,
    [deadline, deadline! + 13_800],
    "one shared pass rearms on completion",
  );
  assert.equal(reads, 1, "late callers must not queue another repair behind the active pass");
  assert.equal((await memberships.authority("a"))?.dirty, false);
  await memberships.tick();
  assert.equal(reads, 2, "a later alarm starts a fresh pass");
  assert.equal(f.alarms.length, 4);
});

test("a rejected tick releases upkeep so the next alarm can repair membership", async () => {
  const f = fixture();
  let rejectSchedule = false;
  const memberships = new NativeMemberships({
    ...f.deps,
    schedule: async (at) => {
      if (rejectSchedule) throw new Error("alarm storage unavailable");
      await f.deps.schedule(at);
    },
  });
  await memberships.reserve(await f.request());
  rejectSchedule = true;
  await assert.rejects(memberships.tick(), /alarm storage unavailable/);
  rejectSchedule = false;
  await memberships.tick();
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a"]);
});

test("a failed completion rearm releases the shared tick for the next alarm", async () => {
  const f = fixture();
  let schedules = 0;
  const memberships = new NativeMemberships({
    ...f.deps,
    schedule: async (at) => {
      if (++schedules === 3) throw new Error("completion alarm write failed");
      await f.deps.schedule(at);
    },
  });
  await memberships.reserve(await f.request());
  await assert.rejects(memberships.tick(), /completion alarm write failed/);
  await memberships.tick();
  assert.equal(schedules, 5);
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a"]);
});

test("a reserve during an old read repairs the newest selection before re-enabling use", async () => {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  const entered = deferred<void>(),
    finish = deferred<NativeMembershipSnapshot>();
  const read = f.deps.read;
  f.deps.read = async () => {
    entered.resolve();
    return finish.promise;
  };
  const old = memberships.refresh("a");
  await entered.promise;
  await memberships.reserve(await f.request());
  const reserved = f.installed.get("a")!;
  f.native.set("a", []);
  assert.equal(reserved.dirty, true);
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.deps.read = read;
  finish.resolve(await read("a", "org"));
  await old;
  assert.notEqual(f.installed.get("a"), reserved);
  assert.deepEqual((await memberships.authority("a"))?.accounts, []);
  assert.deepEqual(f.home.get("a"), []);
});

test("a missing current Home binding fails closed while the other pool remains usable", async () => {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request("a"));
  await memberships.reserve(await f.request("b"));
  await memberships.tick();
  const read = f.deps.read;
  f.deps.read = async (pool, organization) => {
    const result = await read(pool, organization);
    return pool === "a"
      ? {
          ...result,
          accounts: result.accounts.map((account) => ({ ...account, homeReference: null })),
        }
      : result;
  };
  await memberships.tick();
  await assert.rejects(memberships.authority("a"), /refreshing/);
  assert.deepEqual((await memberships.authority("b"))?.accounts, ["auth-b"]);
});

test("authority retains its acknowledgement during failed reads and expires at the fixed grace bound", async () => {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  const read = f.deps.read;
  f.deps.read = async () => {
    throw new Error("tools down");
  };
  f.advance(membershipTtlMs);
  await memberships.tick();
  assert.ok(await memberships.authority("a"));
  f.advance(membershipGraceMs);
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.deps.read = read;
  await memberships.tick();
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a"]);
});

test("authority requires the exact clean policy acknowledgement and never extends a failed renewal", async () => {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  const install = f.deps.install;
  f.deps.install = async () => {
    throw new Error("local install failed");
  };
  await memberships.tick();
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.deps.install = install;
  await memberships.tick();
  const accepted = await memberships.authority("a");
  assert.ok(accepted);
  assert.deepEqual(Object.keys(accepted).sort(), [
    "accounts",
    "dirty",
    "expiresAt",
    "organization",
    "pool",
    "revision",
  ]);
  f.advance(5_000);
  f.deps.install = async () => {
    throw new Error("renewal failed");
  };
  await memberships.tick();
  assert.ok(
    await memberships.authority("a"),
    "the previous acknowledged policy is still inside its lease",
  );
  f.advance(membershipTtlMs - 5_000);
  assert.deepEqual(await memberships.authority("a"), accepted);
  f.advance(membershipGraceMs);
  await assert.rejects(memberships.authority("a"), /refreshing/);
});

test("one native account expands its exact multi-project Home reference into pool authority", async () => {
  const f = fixture();
  const read = f.deps.read;
  f.deps.read = async (pool, organization) => {
    const snapshot = await read(pool, organization);
    return {
      ...snapshot,
      accounts: snapshot.accounts.map((account) => ({
        ...account,
        homeReference: 'sbhrefs1:["parent","project-a","project-b"]',
      })),
    };
  };
  const memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  const expected = ["parent", "project-a", "project-b"];
  assert.deepEqual((await memberships.authority("a"))?.accounts, expected);
  assert.deepEqual(f.home.get("a"), expected);
  assert.deepEqual(f.installed.get("a")?.accounts, expected);
});

for (const operation of ["reconcile", "actual"] as const)
  for (const empty of [false, true])
    test(`host-confirmed native retirement survives ${operation} failure with ${empty ? "empty" : "changed"} membership`, async () => {
      const f = fixture();
      if (empty) f.native.set("a", []);
      const read = f.deps.read;
      let deleted = false,
        reads = 0;
      f.deps.read = async (pool, organization) => {
        reads++;
        return deleted
          ? { pool, organization, native: false, accounts: [] }
          : read(pool, organization);
      };
      f.deps[operation] = async () => {
        throw new Error("Home unavailable");
      };
      const memberships = new NativeMemberships(f.deps);
      await memberships.reserve(await f.request());
      await assert.rejects(memberships.refresh("a"), /Home unavailable/);
      await memberships.retire("a", f.deps.now());
      deleted = true;
      f.alarms.length = 0;
      const previousReads = reads;
      f.advance(120_000);
      await new NativeMemberships(f.deps).tick();
      assert.equal(reads, previousReads);
      assert.deepEqual(f.alarms, []);
      assert.equal(f.installed.get("a")?.dirty, true);
      assert.deepEqual(f.installed.get("a")?.accounts, []);
    });

test("retirement survives reconstruction, retains denial and stops membership ticks", async () => {
  const f = fixture();
  let reads = 0;
  const read = f.deps.read;
  f.deps.read = async (pool, organization) => {
    reads++;
    return read(pool, organization);
  };
  let memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  await memberships.retire("a", f.deps.now());
  memberships = new NativeMemberships(f.deps);
  f.alarms.length = 0;
  const previousReads = reads;
  f.advance(120_000);
  await memberships.tick();
  await memberships.refresh("a");
  assert.equal(reads, previousReads);
  assert.deepEqual(f.alarms, []);
  assert.equal(await memberships.configured(), true);
  await assert.rejects(memberships.authority("a"), /refreshing/);
  assert.equal(f.installed.get("a")?.dirty, true);
  assert.deepEqual(f.installed.get("a")?.accounts, []);
});

test("retiring one pool preserves the other pool's five-second renewal", async () => {
  const f = fixture();
  const reads: string[] = [];
  const read = f.deps.read;
  f.deps.read = async (pool, organization) => {
    reads.push(pool);
    return read(pool, organization);
  };
  const memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request("a"));
  await memberships.reserve(await f.request("b"));
  await memberships.tick();
  await memberships.retire("a", f.deps.now());
  const before = (await memberships.authority("b"))!.expiresAt;
  f.advance(5_000);
  reads.length = 0;
  f.alarms.length = 0;
  await memberships.tick();
  assert.deepEqual(reads, ["b"]);
  assert.deepEqual(f.alarms, [f.deps.now() + 5_000, f.deps.now() + 5_000]);
  assert.ok((await memberships.authority("b"))!.expiresAt > before);
  await assert.rejects(memberships.authority("a"), /refreshing/);
});

test("retirement acknowledges a blocked host read and completion does not rearm it", async () => {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  f.home.set("a", ["unchanged-during-retirement"]);
  const entered = deferred<void>(),
    release = deferred<NativeMembershipSnapshot>();
  const snapshot = await f.deps.read("a", "org");
  f.deps.read = async () => {
    entered.resolve();
    return release.promise;
  };
  const ticking = memberships.tick();
  await entered.promise;
  await memberships.retire("a", f.deps.now());
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.alarms.length = 0;
  release.resolve(snapshot);
  await ticking;
  assert.deepEqual(f.alarms, []);
  assert.equal(f.installed.get("a")?.dirty, true);
  assert.deepEqual(
    f.home.get("a"),
    ["unchanged-during-retirement"],
    "the superseded read must not reconcile Home",
  );
});

test("an in-flight clean install finishes before retirement's denying acknowledgement", async () => {
  const f = fixture(),
    retired = deferred<void>();
  let retiring = false;
  const deps = {
    ...f.deps,
    abort(pool: string) {
      f.deps.abort(pool);
      if (retiring) retired.resolve();
    },
  };
  const memberships = new NativeMemberships(deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  const entered = deferred<void>(),
    release = deferred<void>(),
    install = deps.install;
  deps.install = async (policy) => {
    if (!policy.dirty) {
      entered.resolve();
      await release.promise;
    }
    await install(policy);
  };
  const refreshing = memberships.refresh("a");
  await entered.promise;
  retiring = true;
  const retirement = memberships.retire("a", f.deps.now());
  await retired.promise;
  await assert.rejects(memberships.authority("a"), /refreshing/);
  release.resolve();
  await Promise.all([refreshing, retirement]);
  assert.equal(f.installed.get("a")?.dirty, true);
  assert.deepEqual(f.installed.get("a")?.accounts, []);
  await assert.rejects(memberships.authority("a"), /refreshing/);
});

test("only a fresh host confirmation after the refusal window reactivates a rolled-back removal", async () => {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  await memberships.retire("a", f.deps.now());
  await assert.rejects(memberships.ensure("a", "org"), /retired/);
  f.advance(60_000);
  const read = f.deps.read;
  f.deps.read = async (pool, organization) => ({ pool, organization, native: false, accounts: [] });
  await assert.rejects(memberships.ensure("a", "org"), /retired/);
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.deps.read = read;
  await memberships.ensure("a", "org");
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a"]);
  f.alarms.length = 0;
  f.advance(5_000);
  await memberships.tick();
  assert.equal(f.alarms.at(-1), f.deps.now() + 5_000);
});

test("a stale or newer signed reservation cannot revive a retired pool", async () => {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  const stale = await f.request();
  await memberships.retire("a", f.deps.now());
  await assert.rejects(memberships.reserve(stale), /retired/);
  f.advance(1);
  f.alarms.length = 0;
  await memberships.reserve(await f.request());
  await memberships.tick();
  await assert.rejects(memberships.authority("a"), /refreshing/);
  assert.deepEqual(f.alarms, []);
  assert.equal(f.installed.get("a")?.dirty, true);
});

test("a reservation paused before persistence cannot overwrite a later retirement", async () => {
  const f = fixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  let hold = false;
  const memberships = new NativeMemberships({
    ...f.deps,
    invalidateView: async () => {
      if (hold) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
    },
  });
  await memberships.reserve(await f.request());
  await memberships.tick();
  f.alarms.length = 0;
  hold = true;
  const reservation = memberships.reserve(await f.request());
  await entered.promise;
  await memberships.retire("a", f.deps.now());
  release.resolve();
  await assert.rejects(reservation, /retired/);
  await memberships.tick();
  assert.deepEqual(f.alarms, []);
  await assert.rejects(memberships.authority("a"), /refreshing/);
});

test("retained and unconfirmed pools keep their existing behavior after pool deletion", async () => {
  for (const state of ["absent", "reserved", "retained"] as const) {
    const f = fixture();
    f.deps.read = async (pool, organization) => ({
      pool,
      organization,
      native: false,
      accounts: [],
    });
    const memberships = new NativeMemberships(f.deps);
    if (state !== "absent") await memberships.reserve(await f.request());
    if (state === "retained") await memberships.ensure("a", "org");
    const before = await f.deps.storage.get("native-pool-memberships-v1");
    const aborted = [...f.aborted];
    await memberships.retire("a", f.deps.now());
    assert.deepEqual(await f.deps.storage.get("native-pool-memberships-v1"), before, state);
    assert.deepEqual(f.aborted, aborted, state);
    await memberships.ensure("a", "org");
    assert.equal(await memberships.configured(), state !== "absent", state);
  }
});

test("a native record from the previous layout retains retirement across a failed install and retry", async () => {
  const f = fixture();
  await f.deps.storage.put("native-pool-memberships-v1", {
    a: {
      pool: "a",
      organization: "org",
      revision: 4,
      expiresAt: f.deps.now() + 15_000,
      accounts: ["auth-a"],
      dirty: false,
      native: true,
      checkedAt: f.deps.now(),
      installedRevision: 4,
      installedUntil: f.deps.now() + 15_000,
    },
  });
  const memberships = new NativeMemberships(f.deps),
    install = f.deps.install;
  f.deps.install = async () => {
    throw new Error("install failed");
  };
  await assert.rejects(memberships.retire("a", f.deps.now()), /install failed/);
  f.deps.install = install;
  await memberships.retire("a", f.deps.now());
  assert.equal(f.installed.get("a")?.dirty, true);
  const alarms = [...f.alarms];
  await new NativeMemberships(f.deps).tick();
  assert.deepEqual(f.alarms, alarms);
  await assert.rejects(memberships.authority("a"), /refreshing/);
});
