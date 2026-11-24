import assert from "node:assert/strict";
import { test } from "node:test";
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

// The count a lost release leaves: six leases another isolate took, whose closures died with it.
const leakedRow = (changedAt: number) => ({
  identity,
  phase: "draining",
  active: 6,
  known: true,
  leases: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`dead-${index}`, "active"])),
  changedAt,
});
const activityKey = `runtime-activity-v1:${JSON.stringify([identity.slotId, identity.bootId])}`;

test("an operator releases a dead isolate's draining count only once it has stood still the leaked-streams bound", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await storage.put(activityKey, { ...leakedRow(Date.now()), phase: "open" });
  await assert.rejects(activity.releaseStill(identity, 300_000), /selection/, "an open count");
  await storage.put(activityKey, leakedRow(Date.now()));
  context.mock.timers.tick(299_999);
  await assert.rejects(activity.releaseStill(identity, 300_000), /draining/, "still moving");
  context.mock.timers.tick(1);
  const aborted = AbortSignal.abort();
  await assert.rejects(activity.releaseStill(identity, 300_000, aborted), /abort/iu);
  assert.equal(
    (await activity.inspect(identity))?.active,
    6,
    "a caller that gave up commits nothing",
  );
  assert.deepEqual(await activity.releaseStill(identity, 300_000), {
    released: 6,
    stillMs: 300_000,
  });
  const row = await activity.inspect(identity);
  assert.deepEqual([row?.phase, row?.active, row?.known], ["draining", 0, true]);
  // A re-send whose first answer was lost finds nothing left to release, and refuses nothing.
  assert.deepEqual(await activity.releaseStill(identity, 300_000), { released: 0, stillMs: 0 });
  // The ordinary retirement now goes ahead, as for any drained runtime.
  await activity.retire(identity);
  assert.equal((await activity.inspect(identity))?.phase, "retiring");
});

test("an operator never releases a lease this isolate still holds, nor an unknown count", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await activity.initialize(identity, true);
  // One long stream this isolate serves: its count stands still, but the stream is live.
  const done = await activity.acquire(identity);
  await activity.drain(identity);
  context.mock.timers.tick(3_600_000);
  await assert.rejects(activity.releaseStill(identity, 300_000), /draining/, "a live lease");
  await done();
  assert.deepEqual(await activity.releaseStill(identity, 300_000), { released: 0, stillMs: 0 });
  await storage.put(activityKey, { ...leakedRow(0), known: false });
  await assert.rejects(activity.releaseStill(identity, 300_000), /uncertain/, "an unknown count");
});

test("a stream whose release write failed no longer holds the operator's override", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await activity.initialize(identity, true);
  const done = await activity.acquire(identity);
  await activity.drain(identity);
  // The stream ended, but its release never reached storage.
  const transaction = storage.transaction.bind(storage);
  storage.transaction = async () => {
    throw new Error("storage refused the release");
  };
  await assert.rejects(done(), /storage refused/u);
  storage.transaction = transaction;
  context.mock.timers.tick(300_000);
  assert.deepEqual(await activity.releaseStill(identity, 300_000), {
    released: 1,
    stillMs: 300_000,
  });
});

test("the operator's check reads the same rules and whose leases they are, and writes nothing", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await storage.put(activityKey, leakedRow(Date.now()));
  const stored = JSON.stringify(await storage.get(activityKey));
  assert.equal((await activity.checkStill(identity, 300_000)).refusal, "still_moving");
  context.mock.timers.tick(300_000);
  assert.deepEqual(await activity.checkStill(identity, 300_000), {
    refusal: null,
    phase: "draining",
    active: 6,
    known: true,
    stillMs: 300_000,
    leases: { current: 0, gone: 6 },
  });
  assert.equal(JSON.stringify(await storage.get(activityKey)), stored, "nothing was written");
  // A lease this isolate holds shows as current, and the check says the override would refuse it.
  const other = { ...identity, slotId: "runtime-2", instanceId: "runtime-2", bootId: "boot-2" };
  await activity.initialize(other, true);
  await activity.acquire(other);
  await activity.drain(other);
  context.mock.timers.tick(300_000);
  const live = await activity.checkStill(other, 300_000);
  assert.deepEqual([live.refusal, live.leases], ["live_lease", { current: 1, gone: 0 }]);
});
