import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { NativeMemberships } from "./membership.ts";
import {
  membershipPrefix,
  membershipReadMs,
  membershipRefreshMs,
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

test("level repair removes a late stale attach at the next host read and after controller restart", async () => {
  const f = fixture();
  let memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  f.home.set("a", ["auth-a", "revoked"]);
  f.advance(membershipReadMs);
  await memberships.tick();
  assert.deepEqual(f.home.get("a"), ["auth-a"]);
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
  const renewed = f.installed.get("a")!;
  f.advance(membershipRefreshMs);
  await memberships.tick();
  assert.equal(reads, 1, "a later alarm renews the clean lease without a host read");
  assert.ok(f.installed.get("a")!.expiresAt > renewed.expiresAt);
  assert.equal(f.alarms.length, 4);
  f.advance(membershipReadMs);
  await memberships.tick();
  assert.equal(reads, 2, "the read interval starts a fresh host read");
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

test("a pool whose only Home binding is missing fails closed while the other pool remains usable", async () => {
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
  // This host change arrives without a reservation, so only the next host read sees it.
  f.advance(membershipReadMs);
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
  assert.deepEqual(reads, [], "the clean pool renews without a host read");
  assert.deepEqual(f.alarms, [f.deps.now() + 5_000, f.deps.now() + 5_000]);
  assert.ok((await memberships.authority("b"))!.expiresAt > before);
  await assert.rejects(memberships.authority("a"), /refreshing/);
  f.advance(membershipReadMs);
  await memberships.tick();
  assert.deepEqual(reads, ["b"], "the retired pool is never read again");
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
  f.advance(membershipReadMs);
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

test("a pool deleted while reserved and unconfirmed keeps refusing authority", async () => {
  const f = fixture();
  const memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await assert.rejects(memberships.authority("a"), { status: 503, code: "backend_unavailable" });
  const installed = f.installed.get("a");
  const aborted = [...f.aborted];
  await memberships.retire("a", f.deps.now());
  // Retire acts only on a confirmed pool: nothing reaches the pool's runtime or Home, and the
  // reservation's own refusal stands.
  assert.equal(f.installed.get("a"), installed);
  assert.deepEqual(f.aborted, aborted);
  assert.equal(f.home.get("a"), undefined);
  await assert.rejects(memberships.authority("a"), { status: 503, code: "backend_unavailable" });
});

test("retiring a confirmed pool writes its tombstone and authority then refuses", async () => {
  const f = fixture();
  const memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request());
  await memberships.tick();
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a"]);
  assert.deepEqual(f.home.get("a"), ["auth-a"]);
  const aborted = f.aborted.length;
  await memberships.retire("a", f.deps.now());
  assert.equal(f.aborted.length, aborted + 1);
  // The pool's runtime is told at once that it has no accounts.
  assert.deepEqual(f.installed.get("a")?.accounts, []);
  await assert.rejects(memberships.authority("a"), { status: 503, code: "backend_unavailable" });
  // The tombstone refuses the pool's return and a new reservation within its window.
  await assert.rejects(memberships.ensure("a", "org"), /retired/);
  await assert.rejects(memberships.reserve(await f.request()), /retired/);
  await memberships.tick();
  await assert.rejects(memberships.authority("a"), { status: 503, code: "backend_unavailable" });
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

test("a handoff callback waits for the initial host read before starting a fresh repair", async () => {
  const f = fixture();
  const initialRead = deferred<void>();
  const releaseInitial = deferred<void>();
  const callbackEntered = deferred<void>();
  let reads = 0;
  const memberships = new NativeMemberships({
    ...f.deps,
    read: async (pool, organization) => {
      reads++;
      const snapshot = await f.deps.read(pool, organization);
      if (reads === 1) {
        initialRead.resolve();
        await releaseInitial.promise;
      }
      return snapshot;
    },
  });
  const refresh = memberships.refresh.bind(memberships);
  memberships.refresh = (pool) => {
    const work = refresh(pool);
    callbackEntered.resolve();
    return work;
  };
  const first = memberships.ensure("a", "org");
  await initialRead.promise;
  await memberships.reserve(await f.request());
  f.native.set("a", ["auth-current"]);
  const callback = memberships.tick();
  try {
    await callbackEntered.promise;
    // This queued read completes after any repair queued by the callback.
    assert.equal(await memberships.configured(), true);
    assert.equal(reads, 1, "the callback must not race the pending first host read");
    await assert.rejects(memberships.authority("a"), /refreshing/);
  } finally {
    releaseInitial.resolve();
    await Promise.all([first, callback]);
  }
  assert.equal(reads, 2, "the callback still renews authority from a fresh host read");
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-current"]);
});

test("a failed initial host read releases initialization so the next request can recover", async () => {
  const f = fixture();
  let reads = 0;
  const memberships = new NativeMemberships({
    ...f.deps,
    read: async (pool, organization) => {
      if (++reads === 1) throw new Error("host temporarily unavailable");
      return f.deps.read(pool, organization);
    },
  });
  await assert.rejects(memberships.ensure("a", "org"), /temporarily unavailable/);
  await memberships.ensure("a", "org");
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a"]);
});

// One linked account that doesn't resolve to Home must not refuse the pool's other accounts.
type SnapshotAccount = NativeMembershipSnapshot["accounts"][number];
type Unresolve = (account: SnapshotAccount) => SnapshotAccount;

async function partlyUnresolved(unresolve: Unresolve) {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  f.native.set("a", ["auth-a", "auth-c", "auth-d"]);
  const read = f.deps.read;
  let unresolved = true;
  f.deps.read = async (pool, organization) => {
    const result = await read(pool, organization);
    return {
      ...result,
      accounts: result.accounts.map((account) =>
        unresolved && account.homeReference === "auth-d" ? unresolve(account) : account,
      ),
    };
  };
  await memberships.reserve(await f.request("a"));
  await memberships.tick();
  return { f, memberships, resolve: () => (unresolved = false) };
}

const unresolvedCases: ReadonlyArray<readonly [string, Unresolve]> = [
  ["without a Home reference", (account) => ({ ...account, homeReference: null })],
  [
    "just linked and not yet copied",
    (account) => ({ ...account, driverRevision: null, bindingRevision: null, homeReference: null }),
  ],
  [
    "the host sends as reconnecting (a new generation)",
    (account) => ({ ...account, generation: 2, homeReference: null }),
  ],
];
for (const [name, unresolve] of unresolvedCases) {
  test(`an account ${name} is left out while the pool's other accounts are served`, async () => {
    const { f, memberships, resolve } = await partlyUnresolved(unresolve);
    // The pool is valid and clean: authority answers with the resolved accounts only.
    assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a", "auth-c"]);
    assert.deepEqual(f.installed.get("a")?.accounts, ["auth-a", "auth-c"]);
    assert.deepEqual(f.home.get("a"), ["auth-a", "auth-c"]);
    // It rejoins on the next membership read once it resolves.
    resolve();
    f.advance(membershipReadMs);
    await memberships.tick();
    assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a", "auth-c", "auth-d"]);
    assert.deepEqual(f.home.get("a"), ["auth-a", "auth-c", "auth-d"]);
  });
}

test("an unresolved account is logged once, counted while it repeats, and logged again when it returns", async () => {
  // Observing spies: the real console still prints.
  const warned = mock.method(console, "warn");
  const informed = mock.method(console, "info");
  try {
    const { f, memberships, resolve } = await partlyUnresolved((account) => ({
      ...account,
      homeReference: null,
    }));
    for (let pass = 0; pass < 2; pass++) {
      f.advance(membershipReadMs);
      await memberships.tick();
    }
    const lines = (spy: typeof warned, event: string) =>
      spy.mock.calls.map((call) => call.arguments).filter(([name]) => name === event);
    assert.deepEqual(lines(warned, "POOL_MEMBERSHIP_ACCOUNT_UNRESOLVED"), [
      [
        "POOL_MEMBERSHIP_ACCOUNT_UNRESOLVED",
        { account: "account-auth-d", reason: "no_home_reference" },
      ],
    ]);
    resolve();
    f.advance(membershipReadMs);
    await memberships.tick();
    assert.deepEqual(lines(informed, "POOL_MEMBERSHIP_ACCOUNT_RESOLVED"), [
      ["POOL_MEMBERSHIP_ACCOUNT_RESOLVED", { account: "account-auth-d", repeats: 2 }],
    ]);
  } finally {
    warned.mock.restore();
    informed.mock.restore();
  }
});

test("an account that was served and stops resolving loses its Home link before the policy is clean again", async () => {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  f.native.set("a", ["auth-a", "auth-d"]);
  await memberships.reserve(await f.request("a"));
  await memberships.tick();
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a", "auth-d"]);
  const read = f.deps.read;
  f.deps.read = async (pool, organization) => {
    const result = await read(pool, organization);
    return {
      ...result,
      accounts: result.accounts.map((account) =>
        account.homeReference === "auth-d" ? { ...account, homeReference: null } : account,
      ),
    };
  };
  f.advance(membershipReadMs);
  await memberships.tick();
  assert.deepEqual(f.home.get("a"), ["auth-a"]);
  assert.deepEqual((await memberships.authority("a"))?.accounts, ["auth-a"]);
});

test("a pool none of whose linked accounts resolve stays refused and keeps its Home links", async () => {
  const f = fixture(),
    memberships = new NativeMemberships(f.deps);
  await memberships.reserve(await f.request("a"));
  await memberships.tick();
  const linked = f.home.get("a");
  const read = f.deps.read;
  f.deps.read = async (pool, organization) => {
    const result = await read(pool, organization);
    return {
      ...result,
      accounts: result.accounts.map((account) => ({ ...account, homeReference: null })),
    };
  };
  f.advance(membershipReadMs);
  await memberships.tick();
  await assert.rejects(memberships.authority("a"), /refreshing/);
  assert.deepEqual(f.home.get("a"), linked);
});
