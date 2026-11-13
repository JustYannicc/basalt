import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolControl, type ControlStorage } from "./attribution.ts";
import { accountsView, HomeClient, PoolHome } from "./control.ts";
import { PoolViewSnapshots, type HomeViewData } from "./view-snapshot.ts";
import { signPoolToken } from "./token.ts";
import type { PoolView } from "../../apps/pool/contract.ts";

class MemoryStorage implements ControlStorage {
  values = new Map<string, unknown>();
  writes: string[] = [];
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.writes.push(JSON.stringify({ key, value }));
    this.values.set(key, structuredClone(value));
  }
  async getAlarm() {
    return null;
  }
  async setAlarm() {}
}
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const observed = "2026-11-01T10:00:00.000Z";
function data(label = "Old"): HomeViewData {
  return {
    accounts: [
      {
        id: "a",
        provider: "codex",
        label,
        plan: null,
        state: "active",
        message: null,
        windows: [],
        observedAt: observed,
        freshness: "fresh",
        readingFailed: false,
        collection: { status: null, errorCode: null, lastAttemptAt: null },
        nextReadAt: null,
        earliestResetAt: null,
        bankedResets: null,
      },
    ],
    readAt: { membership: observed, credentials: observed, quota: observed },
  };
}

test("retained quota freshness follows the original reading deadline, not cache provenance", async () => {
  const expires = "2026-11-01T10:30:00.000Z";
  const account = accountsView(
    [{ id: "a", provider: "codex" }],
    [
      {
        credential: { credential_id: "a" },
        collection: {
          freshness: "fresh",
          status: "success",
          observed_at: observed,
          expires_at: expires,
        },
        windows: [
          {
            id: "codex-1-week",
            scope: "account",
            window_seconds: 604800,
            observed_at: observed,
            expires_at: expires,
            remaining_ratio: 0.8,
          },
        ],
      },
    ],
    new Set(["a"]),
  )[0]!;
  for (const [at, expected] of [
    ["2026-11-01T10:05:00.000Z", "fresh"],
    [expires, "stale"],
    ["2026-11-01T11:00:00.000Z", "stale"],
  ] as const) {
    const cache = new PoolViewSnapshots(new MemoryStorage(), () => {});
    await cache.view("pool-a", false, async () => ({ ...data(), accounts: [account] }));
    const home = new PoolHome(
      new HomeClient(async () => {
        throw Error("held Home");
      }),
      "pool-a",
    );
    const result = await home.view(false, cache, false, () => new Date(at));
    assert.equal(result.reading?.source, "snapshot");
    assert.equal(result.accounts[0]!.freshness, expected);
    assert.equal(result.accounts[0]!.observedAt, observed);
  }
});

test("snapshot miss waits for the complete view and persists it across restarts", async () => {
  const storage = new MemoryStorage();
  const first = new PoolViewSnapshots(storage, () => {});
  const result = await first.view("pool-a", false, async () => data());
  assert.equal(result.source, "live");
  const next = gate<HomeViewData>();
  const started = gate<void>();
  const restored = new PoolViewSnapshots(storage, () => {});
  const snapshot = await restored.view("pool-a", false, () => {
    started.resolve();
    return next.promise;
  });
  await started.promise;
  assert.equal(snapshot.source, "snapshot");
  assert.equal(snapshot.data.accounts[0]!.label, "Old");
  assert.deepEqual(snapshot.data.readAt, result.data.readAt);
  next.resolve(data("New"));
  const fresh = await restored.view("pool-a", true, async () => {
    return data("Current");
  });
  assert.equal(fresh.source, "live");
  assert.equal(fresh.data.accounts[0]!.label, "Current");
});

test("a large complete Home result persists without exceeding the storage value limit", async () => {
  class LimitedStorage extends MemoryStorage {
    override async put(key: string, value: unknown) {
      assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024);
      await super.put(key, value);
    }
  }
  const storage = new LimitedStorage();
  const large = data("Pool account");
  large.accounts[0] = { ...large.accounts[0]!, label: "界".repeat(100_000) };
  await new PoolViewSnapshots(storage, () => {}).view("pool-a", false, async () => large);
  const restored = new PoolViewSnapshots(storage, () => {});
  const result = await restored.view("pool-a", false, async () => large);
  assert.equal(result.source, "snapshot");
  assert.deepEqual(result.data, large);
});

test("snapshot requests coalesce while a fresh follow-up starts after its baseline", async () => {
  const cache = new PoolViewSnapshots(new MemoryStorage(), () => {});
  await cache.view("a", false, async () => data());
  const pending = gate<HomeViewData>();
  const started = gate<void>();
  let reads = 0;
  const read = () => {
    reads++;
    started.resolve();
    return pending.promise;
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => cache.view("a", false, read)));
  assert.ok(results.every((value) => value.source === "snapshot"));
  await started.promise;
  const fresh = cache.view("a", true, read);
  pending.resolve(data("New"));
  assert.equal((await fresh).data.accounts[0]!.label, "New");
  assert.equal(reads, 2);
});

test("an explicit fresh read never reuses a completed abandoned revalidation", async () => {
  const jobs: Promise<void>[] = [];
  const cache = new PoolViewSnapshots(new MemoryStorage(), (work) => jobs.push(work));
  await cache.view("a", false, async () => data());
  await cache.view("a", false, async () => data("Already old"));
  await Promise.all(jobs);
  let reads = 0;
  const fresh = await cache.view("a", true, async () => {
    reads++;
    return data("Current");
  });
  assert.equal(reads, 1);
  assert.equal(fresh.source, "live");
  assert.equal(fresh.data.accounts[0]!.label, "Current");
});

test("failed revalidation preserves the snapshot and reports stale rather than success", async () => {
  const cache = new PoolViewSnapshots(new MemoryStorage(), () => {});
  await cache.view("a", false, async () => data());
  const pending = gate<HomeViewData>();
  await cache.view("a", false, () => pending.promise);
  const fresh = cache.view("a", true, async () => {
    throw Error("Home still unavailable");
  });
  pending.reject(Error("Home unavailable"));
  const result = await fresh;
  assert.equal(result.source, "snapshot");
  assert.equal(result.revalidationFailed, true);
  assert.equal(result.data.accounts[0]!.label, "Old");
  assert.equal(result.data.readAt.credentials, observed);
});

test("invalidation survives restart, is scoped, and fences an in-flight old result", async () => {
  const storage = new MemoryStorage();
  const cache = new PoolViewSnapshots(storage, () => {});
  await cache.view("a", false, async () => data());
  await cache.view("b", false, async () => data());
  const pending = gate<HomeViewData>();
  const started = gate<void>();
  let reads = 0;
  const read = () => {
    reads++;
    started.resolve();
    return reads === 1 ? pending.promise : Promise.resolve(data("After change"));
  };
  await cache.view("a", false, read);
  await started.promise;
  await cache.invalidate("a");
  const fresh = cache.view("a", true, read);
  pending.resolve(data("Obsolete"));
  assert.equal((await fresh).data.accounts[0]!.label, "After change");
  assert.equal(reads, 3);
  const restored = new PoolViewSnapshots(storage, () => {});
  assert.equal((await restored.view("b", false, async () => data())).source, "snapshot");
  await restored.invalidate();
  assert.equal(
    (await new PoolViewSnapshots(storage, () => {}).view("a", false, async () => data("Live")))
      .source,
    "live",
  );
});

test("invalidation expires the saved result after a completed revalidation", async () => {
  const jobs: Promise<void>[] = [];
  const cache = new PoolViewSnapshots(new MemoryStorage(), (work) => jobs.push(work));
  await cache.view("a", false, async () => data());
  await cache.view("a", false, async () => data("Before removal"));
  await Promise.all(jobs);
  await cache.invalidate("a");
  const result = await cache.view("a", true, async () => data("After removal"));
  assert.equal(result.data.accounts[0]!.label, "After removal");
});

test("retained views preserve app members and classify subscriptions without exposing raw Home", async () => {
  const cache = new PoolViewSnapshots(new MemoryStorage(), () => {});
  const retained = data();
  retained.accounts.push({
    ...retained.accounts[0]!,
    id: "app-key",
    provider: "typesafe",
    freshness: "never",
  });
  await cache.view("pool-a", false, async () => retained);
  const home = new PoolHome(
    new HomeClient(async () => {
      throw Error("held Home");
    }),
    "pool-a",
  );
  const member = await home.view(false, cache);
  assert.equal(member.isOwner, false);
  assert.equal(member.removals, undefined);
  assert.deepEqual(
    member.accounts.map((account) => account.id),
    ["a", "app-key"],
  );
  assert.deepEqual(member.subscriptionAccountIds, ["a"]);
  assert.equal(member.accounts[0]!.freshness, "stale");
  assert.equal(member.accounts[0]!.observedAt, observed);
  assert.equal(member.reading?.source, "snapshot");
  assert.equal("credentials" in member, false);
  assert.equal("membership" in member, false);
});

test("a failed Home branch drains the remaining reads before another revalidation may start", async () => {
  const cache = new PoolViewSnapshots(new MemoryStorage(), () => {});
  await cache.view("pool-a", false, async () => data());
  const membership = gate<Response>();
  const credentials = gate<void>();
  let reads = 0;
  const home = new PoolHome(
    new HomeClient(async (path) => {
      if (path.endsWith("/credentials")) {
        reads++;
        credentials.resolve();
        return Response.json({}, { status: 503 });
      }
      if (path.endsWith("/channel-groups")) return membership.promise;
      if (path.endsWith("/channel-group-details?channel_group_id=1"))
        return Response.json({
          channel_group_details: [{ id: 1, channel_group_id: 1, auth_id: "a" }],
        });
      if (path.endsWith("/quota/credentials/a")) return Response.json({ windows: [] });
      throw Error("Unexpected read");
    }),
    "pool-a",
  );
  await home.view(false, cache);
  await credentials.promise;
  const followUp = home.view(false, cache, true);
  membership.resolve(
    Response.json({ channel_groups: [{ id: 1, channel_name: "signalbox-pool-pool-a" }] }),
  );
  const result = await followUp;
  assert.equal(result.reading?.revalidationFailed, true);
  assert.equal(result.reading?.source, "snapshot");
  assert.equal(reads, 2);
});

test("Home writes invalidate before and after success or uncertain failure", async () => {
  let invalidations = 0;
  const client = new HomeClient(
    async (_path, init) => {
      if (init?.method === "DELETE") throw Error("lost response");
      return Response.json({ files: [] });
    },
    Date.now,
    async () => {
      invalidations++;
    },
  );
  await client.data("/credentials");
  assert.equal(invalidations, 0);
  await client.data("/access/api-keys", { method: "POST" });
  await client.data("/billing/model-prices/import/apply", { method: "POST" });
  await client.data("/quota/collect", { method: "POST" });
  assert.equal(invalidations, 0, "model keys, prices and automatic quota sampling retain the view");
  await client.data("/credentials/status", { method: "PATCH" });
  assert.equal(invalidations, 2);
  await assert.rejects(client.data("/channel-group-details/1", { method: "DELETE" }));
  assert.equal(invalidations, 4);
});

test("PoolControl persists only public in-pool data, rejects bad tokens, and strips owner-only history for members", async () => {
  const storage = new MemoryStorage();
  const key = "ab".repeat(32);
  let homeReads = 0;
  let label = "Old";
  const deps = {
    signingKey: key,
    home: async (path: string) => {
      homeReads++;
      if (path.endsWith("/channel-groups"))
        return Response.json({
          channel_groups: [{ id: 1, channel_name: "signalbox-pool-pool-a" }],
        });
      if (path.includes("/channel-group-details?"))
        return Response.json({
          channel_group_details: [{ id: 1, channel_group_id: 1, auth_id: "a" }],
        });
      if (path.endsWith("/credentials"))
        return Response.json({
          files: [
            { id: "a", provider: "codex", label },
            { id: "private", label: "Other pool" },
          ].map((file) => ({
            ...file,
            proxy_url: "socks5://fixture-proxy-user:fixture-proxy-password@proxy.invalid:1080",
            access_token: "fixture-credential-secret",
          })),
        });
      if (path.endsWith("/quota/credentials/a"))
        return Response.json({
          credential: { credential_id: "a", observed_at: observed, freshness: "fresh" },
          windows: [],
        });
      throw Error("Unexpected Home endpoint");
    },
  };
  const token = await signPoolToken(key, { pool: "pool-a", owner: "owner", organization: "org" });
  const request = (caller: string, bearer = token, fresh = false) =>
    new Request(`https://pool.example/pool/v1/pool${fresh ? "?fresh=true" : ""}`, {
      headers: { authorization: `Bearer ${bearer}`, "x-signalbox-caller": caller },
    });
  const first = await new PoolControl(storage, deps).handle(request("owner"));
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as PoolView).reading?.source, "live");
  const storedBytes = storage.writes.join("\n");
  assert.doesNotMatch(
    storedBytes,
    /fixture-proxy-user|fixture-proxy-password|proxy_url|fixture-credential-secret|access_token/,
  );
  assert.doesNotMatch(storedBytes, /Other pool|"private"/);
  assert.doesNotMatch(storedBytes, /"isOwner"|"inAccounts"|"removals"/);
  label = "Revalidated";
  const control = new PoolControl(storage, deps);
  const member = await control.handle(request("member"));
  const view = (await member.json()) as PoolView;
  assert.equal(view.reading?.source, "snapshot");
  assert.equal(view.isOwner, false);
  assert.equal(view.removals, undefined);
  assert.deepEqual(
    view.accounts.map((account) => account.id),
    ["a"],
  );
  const followUp = (await (
    await control.handle(request("member", token, true))
  ).json()) as PoolView;
  assert.equal(followUp.reading?.source, "live");
  assert.equal(followUp.isOwner, false);
  assert.equal(followUp.accounts[0]!.label, "Revalidated");
  const beforeRefusal = homeReads;
  assert.equal((await control.handle(request("owner", "bad"))).status, 401);
  assert.equal(homeReads, beforeRefusal);
  assert.ok(homeReads > 0);
});

test("a fresh revision-fenced request never joins a body captured before its baseline", async () => {
  const cache = new PoolViewSnapshots(new MemoryStorage(), () => {});
  await cache.view("a", false, async () => data("Saved"));
  const oldBody = gate<HomeViewData>();
  const started = gate<void>();
  await cache.view("a", false, () => {
    started.resolve();
    return oldBody.promise;
  });
  await started.promise;
  // The collector has committed before the caller reads its first revision head.
  let currentReads = 0;
  const fresh = cache.view("a", true, async () => {
    currentReads++;
    return data("Committed");
  });
  oldBody.resolve(data("Before commit"));
  const result = await fresh;
  assert.equal(result.source, "live");
  assert.equal(result.data.accounts[0]!.label, "Committed");
  assert.equal(currentReads, 1);
});

test("a fresh view reloads group policy changed by another Home writer", async () => {
  let policy = "last_resort";
  let groupReads = 0;
  const client = new HomeClient(async (path) => {
    if (path.endsWith("/channel-groups")) {
      groupReads++;
      return Response.json({
        channel_groups: [
          { id: 1, channel_name: "signalbox-pool-pool-a", usage_credit_policy: policy },
        ],
      });
    }
    if (path.includes("/channel-group-details?"))
      return Response.json({ channel_group_details: [] });
    if (path.endsWith("/credentials")) return Response.json({ files: [] });
    throw Error("Unexpected Home read");
  });
  const cache = new PoolViewSnapshots(new MemoryStorage(), () => {});
  const home = new PoolHome(client, "pool-a");
  assert.equal((await home.view(false, cache, true)).usageCreditPolicy, "last_resort");
  policy = "never";
  assert.equal((await home.view(false, cache, true)).usageCreditPolicy, "never");
  assert.equal(
    groupReads,
    2,
    "a committed change's fresh read cannot reuse process-local group metadata",
  );
});
