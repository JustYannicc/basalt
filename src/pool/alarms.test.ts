import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { PoolAlarms } from "./alarms.ts";
import { PoolLifecycle } from "./lifecycle.ts";

function fixture(existing: number | null = null) {
  const memory = new SlotMemory();
  let alarm = existing,
    now = 100;
  const storage = {
    get: memory.get.bind(memory),
    put: memory.put.bind(memory),
    transaction: memory.transaction.bind(memory),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
  };
  return {
    storage,
    scheduler: new PoolAlarms(storage, () => now),
    current: () => alarm,
    fire: (at: number) => {
      now = at;
      alarm = null;
    },
    now: () => now,
  };
}

test("an earlier fleet deadline preserves an already scheduled Home operation through reconstruction", async () => {
  const f = fixture(5_000);
  await f.scheduler.schedule("fleet", 200);
  assert.equal(f.current(), 200);
  f.fire(200);
  const restored = new PoolAlarms(f.storage, f.now);
  assert.deepEqual(await restored.take(), { home: false, fleet: true });
  await restored.rearm();
  assert.equal(f.current(), 5_000);
  f.fire(5_000);
  assert.deepEqual(await restored.take(), { home: true, fleet: false });
});

test("concurrent Home and fleet scheduling keeps each earliest deadline and does not run Home at fleet cadence", async () => {
  const f = fixture();
  await Promise.all([
    f.scheduler.schedule("home", 500),
    f.scheduler.schedule("fleet", 200),
    f.scheduler.schedule("home", 600),
    f.scheduler.schedule("fleet", 250),
  ]);
  assert.equal(f.current(), 200);
  f.fire(200);
  assert.deepEqual(await f.scheduler.take(), { home: false, fleet: true });
  await f.scheduler.schedule("fleet", 300);
  f.fire(300);
  assert.deepEqual(await f.scheduler.take(), { home: false, fleet: true });
  await f.scheduler.rearm();
  assert.equal(f.current(), 500);
});

test("a retained alarm without new bookkeeping still runs its Home upkeep once", async () => {
  const f = fixture();
  assert.deepEqual(await f.scheduler.take(), { home: true, fleet: false });
  assert.deepEqual(await f.scheduler.take(), { home: false, fleet: false });
});

test("lifecycle warmth retains its Home deadline behind an earlier fleet alarm", async () => {
  const f = fixture();
  let running = false;
  await f.scheduler.schedule("fleet", 200);
  const lifecycle = new PoolLifecycle(
    {
      running: () => running,
      start: () => {
        running = true;
      },
      stop: async () => {
        running = false;
      },
      keepAlive: async () => {},
      status: async () => ({ boot_id: "retained-boot", started_at: "fixture" }),
      schedule: (at) => f.scheduler.schedule("home", at),
    },
    f.storage,
    "revision",
    {
      now: f.now,
      sleep: async () => {
        throw new Error("No startup wait expected");
      },
    },
  );
  await lifecycle.warm();
  assert.equal(f.current(), 200);
  f.fire(200);
  assert.deepEqual(await f.scheduler.take(), { home: false, fleet: true });
  await f.scheduler.rearm();
  assert.equal(f.current(), 300_100);
  f.fire(300_100);
  assert.deepEqual(await new PoolAlarms(f.storage, f.now).take(), { home: true, fleet: false });
});
