import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { RuntimeActivity } from "./runtime-slots/activity.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import type { SlotIdentity } from "./runtime-slots/contract.ts";
import { LegacyActivity } from "./runtime-slots/legacy-activity.ts";

const identity: SlotIdentity = {
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: "runtime-1",
  applicationId: "blue",
  applicationVersion: "1",
  instanceId: "runtime-1",
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageInput: "image-1",
  bootId: "boot-1",
};

test("pre-adoption request accounting survives reconstruction and duplicate completion", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const before = new LegacyActivity(storage);
  const complete = await before.acquire();
  assert.equal(await new LegacyActivity(storage).active(), 1);
  await Promise.all([complete(), complete()]);
  assert.equal(await new LegacyActivity(storage).active(), 0);
});

test("a legacy count left by a dead isolate is not live, while this isolate's count is", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  await storage.put("runtime-legacy-activity-v1", 3);
  await new LegacyActivity(storage, "dead-isolate").acquire();
  assert.equal(await new LegacyActivity(storage).active(), 0);
  const complete = await new LegacyActivity(storage).acquire();
  assert.equal(await new LegacyActivity(storage).active(), 1);
  assert.equal(await new LegacyActivity(storage, "next-isolate").active(), 0);
  await complete();
  assert.equal(await new LegacyActivity(storage).active(), 0);
});

test("reconstruction cannot retire a live stream, and a drain fence excludes new admissions", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const first = new RuntimeActivity(storage);
  await first.initialize(identity, true);
  const releases = await Promise.all(Array.from({ length: 20 }, () => first.acquire(identity)));
  const reconstructed = new RuntimeActivity(storage);
  assert.deepEqual(await reconstructed.drain(identity), { active: 20, known: true });
  await assert.rejects(reconstructed.retire(identity), /draining/);
  await assert.rejects(first.acquire(identity), /draining/);
  await Promise.all(releases.map((release) => Promise.all([release(), release()])));
  assert.deepEqual(await reconstructed.drain(identity), { active: 0, known: true });
  await reconstructed.retire(identity);
  await assert.rejects(new RuntimeActivity(storage).retire(identity), /uncertain/);
});

test("untracked retained runtimes keep serving but require positive drain reconciliation", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  const release = await activity.acquire(identity);
  await release();
  await activity.initialize(identity, true);
  assert.deepEqual(await activity.drain(identity), { active: 0, known: false });
  await assert.rejects(activity.retire(identity), /draining/);
});

test("a lost acquisition acknowledgement stays counted and never fabricates a release", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await activity.initialize(identity, true);
  storage.afterCommit = () => {
    throw new Error("lost acknowledgement");
  };
  await assert.rejects(activity.acquire(identity), /lost acknowledgement/);
  storage.afterCommit = () => {};
  assert.deepEqual(await new RuntimeActivity(storage).drain(identity), { active: 1, known: true });
  await assert.rejects(activity.retire(identity), /draining/);
});

test("a rejected completion marker remains counted until the actual owner retries completion", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await activity.initialize(identity, true);
  const complete = await activity.acquire(identity);
  const transaction = storage.transaction.bind(storage);
  context.mock.method(storage, "transaction", (work: Parameters<typeof storage.transaction>[0]) =>
    transaction(async (tx) =>
      work({
        get: tx.get.bind(tx),
        delete: tx.delete.bind(tx),
        put: async () => {
          throw new Error("synthetic completion marker rejected");
        },
      }),
    ),
  );
  await assert.rejects(complete(), /completion marker rejected/);
  context.mock.restoreAll();
  const reconstructed = new RuntimeActivity(storage);
  await reconstructed.reconcile(identity);
  assert.deepEqual(await reconstructed.drain(identity), { active: 1, known: true });
  await assert.rejects(reconstructed.retire(identity), /draining/);
  await complete();
  assert.deepEqual(await reconstructed.drain(identity), { active: 0, known: true });
  await reconstructed.retire(identity);
});

test("changed runtime identity cannot release or drain another runtime's activity", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await activity.initialize(identity, true);
  const replacement = { ...identity, instanceId: "other-runtime" };
  await assert.rejects(activity.acquire(replacement), /identity/);
  await assert.rejects(activity.drain(replacement), /identity/);
  await assert.rejects(activity.initialize(replacement, true), /identity/);
});

test("reusing a logical slot keeps an older boot's completion separate from its replacement", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await activity.initialize(identity, true);
  const oldRelease = await activity.acquire(identity);
  const replacement = { ...identity, bootId: "boot-2" };
  await activity.initialize(replacement, true);
  const newRelease = await activity.acquire(replacement);
  await oldRelease();
  assert.deepEqual(await activity.drain(identity), { active: 0, known: true });
  assert.deepEqual(await activity.drain(replacement), { active: 1, known: true });
  await activity.retire(identity);
  await assert.rejects(activity.retire(replacement), /draining/);
  await newRelease();
  await activity.retire(replacement);
});

for (const failure of ["before", "after"] as const) {
  test(`a release ${failure} decrement commit reconciles after reconstruction without releasing a live stream`, async (context) => {
    const storage = new RuntimeSqlite();
    context.after(() => storage.close());
    const activity = new RuntimeActivity(storage);
    await activity.initialize(identity, true);
    const completed = await activity.acquire(identity);
    let injected = 0;
    const transaction = storage.transaction.bind(storage);
    context.mock.method(
      storage,
      "transaction",
      (work: Parameters<typeof storage.transaction>[0]) => {
        let decrementCommitted = false;
        return transaction(async (tx) => {
          const put = tx.put.bind(tx);
          const wrapped = {
            ...tx,
            get: tx.get.bind(tx),
            put: async (key: string | Record<string, unknown>, value?: unknown) => {
              const decrement =
                typeof key === "string" &&
                key.startsWith("runtime-activity-v1:") &&
                value &&
                typeof value === "object" &&
                "active" in value &&
                value.active === 0 &&
                injected === 0;
              if (decrement && failure === "before") {
                injected++;
                throw new Error("synthetic release before commit");
              }
              if (decrement) decrementCommitted = true;
              return typeof key === "string" ? put(key, value) : put(key);
            },
          };
          return work(wrapped);
        }).then((value) => {
          if (failure === "after" && decrementCommitted && injected === 0) {
            injected++;
            throw new Error("synthetic release after commit");
          }
          return value;
        });
      },
    );
    await assert.rejects(completed(), /synthetic release/);
    context.mock.restoreAll();
    assert.equal(injected, 1);
    const reconstructed = new RuntimeActivity(storage);
    const live = await reconstructed.acquire(identity);
    assert.deepEqual(await reconstructed.drain(identity), { active: 1, known: true });
    await assert.rejects(reconstructed.retire(identity), /draining/);
    await completed();
    assert.deepEqual(await reconstructed.drain(identity), { active: 1, known: true });
    await live();
    assert.deepEqual(await reconstructed.drain(identity), { active: 0, known: true });
    await reconstructed.retire(identity);
  });
}

const activityKey = `runtime-activity-v1:${JSON.stringify([identity.slotId, identity.bootId])}`;
const count = async (activity: RuntimeActivity) => {
  await activity.unproven(identity);
  return (await activity.inspect(identity))?.active;
};

test("a plain call's lease a replaced instance took ends at once; the live instance's never", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const replaced = new RuntimeActivity(storage, "replaced-instance");
  await replaced.initialize(identity, true);
  await Promise.all([replaced.acquire(identity, true), replaced.acquire(identity, true)]);
  const warned = context.mock.method(console, "warn", () => {});
  const live = new RuntimeActivity(storage, "live-instance");
  const release = await live.acquire(identity, true);
  assert.equal(await count(live), 1);
  const [line] = warned.mock.calls.filter(
    (call) => call.arguments[0] === "POOL_RUNTIME_LEASES_RELEASED",
  );
  assert.deepEqual(
    { ...(line?.arguments[1] as object), key: undefined },
    { key: undefined, ordinal: null, kind: "foreign_http", released: 2 },
  );
  await live.reconcile(identity);
  assert.deepEqual(await live.drain(identity), { active: 1, known: true });
  await assert.rejects(live.retire(identity), /draining/);
  await release();
  assert.deepEqual(await live.drain(identity), { active: 0, known: true });
  await live.retire(identity);
});

test("only a proof ends an unstamped lease or another instance's socket, never this instance's", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  // Taken by code before the stamps: no owner, no socket mark.
  await storage.put(activityKey, {
    identity,
    phase: "open",
    active: 1,
    known: true,
    leases: { old: "active" },
    changedAt: 1,
  });
  await new RuntimeActivity(storage, "replaced-instance").acquire(identity);
  const live = new RuntimeActivity(storage, "live-instance");
  await live.acquire(identity);
  await live.acquire(identity, true);
  const pending = await live.unproven(identity);
  assert.equal(pending.unstamped.length, 1);
  assert.equal(pending.foreignSockets.length, 1);
  assert.equal(await count(live), 4, "nothing ends without the proof");
  // A call this instance takes between the read and the release stays counted.
  const late = await live.acquire(identity, true);
  assert.deepEqual(await live.releaseProven(identity, 0), {
    unstamped: 1,
    foreignSockets: 1,
  });
  assert.equal(await count(live), 3);
  assert.deepEqual(await live.unproven(identity), { unstamped: [], foreignSockets: [] });
  await late();
  assert.equal(await count(live), 2);
});

test("leases a rollback took are unstamped after the roll-forward and end only by the proof", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const before = new RuntimeActivity(storage, "before-rollback");
  await before.initialize(identity, true);
  await before.acquire(identity, true);
  // The old code decodes the row without the stamps and writes it back with one lease of its own.
  const Old = Schema.Struct({
    identity: Schema.Unknown,
    phase: Schema.String,
    active: Schema.Number,
    known: Schema.Boolean,
    leases: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    changedAt: Schema.optional(Schema.Number),
  });
  const old = Schema.decodeUnknownSync(Old)(await storage.get(activityKey));
  assert.equal("owners" in old, false, "the old decode drops the stamps");
  await storage.put(activityKey, {
    ...old,
    active: old.active + 1,
    leases: { ...old.leases, rollback: "active" },
  });
  const after = new RuntimeActivity(storage, "after-roll-forward");
  const pending = await after.unproven(identity);
  assert.equal(pending.unstamped.length, 2);
  assert.equal(await count(after), 2, "kept while the container is unread or busy");
  await after.releaseProven(identity, 0);
  assert.equal(await count(after), 0);
});
