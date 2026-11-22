import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { PoolAlarms } from "./alarms.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

// A code update resets the object mid-pass: `take()` already cleared the fleet deadline, and the
// pass's own re-arm never runs. Home keeps the native alarm firing, so `ensure()` sees one set.
test(
  "a fleet pass cut by a reset leaves the fleet a deadline again at the next alarm, and the pass runs",
  { timeout: 20_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    context.mock.method(console, "info", () => {});
    context.mock.method(console, "warn", () => {});
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    f.onModel(async () => new Response("done"));
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "reset-cut-pass",
      configuration: { ...f.configuration, maximum: 2, targetActive: 1 },
    });
    await (await f.model()).text();
    now += 101;
    await f.upkeep();
    const [row] = await f.resourcesWhen((rows) => rows.length === 1 && rows[0]!.phase === "ready");
    await f.settle();
    const alarms = new PoolAlarms(f.old.storage, () => now);
    const before = await alarms.inspect();
    assert.notEqual(before.fleetDeadline, null, "a live row keeps a fleet deadline");
    now = Math.max(now, before.fleetDeadline!) + 1;
    // The cut pass: its take() committed and nothing after it ran.
    assert.equal((await alarms.take()).fleet, true);
    f.reconstruct();
    // The next native alarm is Home's.
    await alarms.schedule("home", now);
    await f.alarm();
    await f.settle();
    const after = await alarms.inspect();
    assert.notEqual(after.fleetDeadline, null, "the fleet has a deadline again while a row exists");
    const health = f.instances.get(row!.target.instanceId)!.fixture.calls.health;
    now = Math.max(now, after.fleetDeadline!) + 1;
    await f.alarm();
    await f.settle();
    assert.ok(
      f.instances.get(row!.target.instanceId)!.fixture.calls.health > health,
      "the next fleet pass ran and read its ready cell",
    );
    assert.equal((await new RuntimeFleetState(f.old.storage, 4).inspect()).length, 1);
    assert.notEqual((await alarms.inspect()).fleetDeadline, null);
  },
);

// The other owner of the shared alarm: a Home pass cut the same way, while fleet rows keep the
// native alarm set, would stop membership renewal for good.
test(
  "a Home pass cut by a reset gets its deadline back at the next fleet alarm",
  { timeout: 20_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    context.mock.method(console, "info", () => {});
    context.mock.method(console, "warn", () => {});
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    f.onModel(async () => new Response("done"));
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "reset-cut-home",
      configuration: { ...f.configuration, maximum: 2, targetActive: 1 },
    });
    await (await f.model()).text();
    now += 101;
    await f.upkeep();
    await f.resourcesWhen((rows) => rows.length === 1 && rows[0]!.phase === "ready");
    await f.settle();
    const alarms = new PoolAlarms(f.old.storage, () => now);
    // Home due first, the fleet a little later.
    await alarms.schedule("home", now);
    await alarms.schedule("fleet", now + 1_000);
    now += 1;
    // The cut Home pass: its take() committed and nothing after it ran.
    assert.deepEqual(await alarms.take(), { home: true, fleet: false });
    f.reconstruct();
    now += 1_000;
    await f.alarm();
    await f.settle();
    const restored = (await alarms.inspect()).homeDeadline;
    assert.notEqual(restored, null, "Home has a deadline again while a membership pool is live");
    assert.ok(restored! <= now, "due at once: the cut pass already lost one renewal");
  },
);

// Restoring Home must follow Home's own condition: with every membership retired Home sleeps, and
// fleet alarms must not drag it to fleet cadence.
test(
  "a Home with no live membership stays asleep through fleet alarms",
  { timeout: 20_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    context.mock.method(console, "info", () => {});
    context.mock.method(console, "warn", () => {});
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    f.onModel(async () => new Response("done"));
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "home-asleep",
      configuration: { ...f.configuration, maximum: 2, targetActive: 1 },
    });
    await (await f.model()).text();
    now += 101;
    await f.upkeep();
    await f.resourcesWhen((rows) => rows.length === 1 && rows[0]!.phase === "ready");
    await f.settle();
    const memberships =
      (await f.old.storage.get<Record<string, Record<string, unknown>>>(
        "native-pool-memberships-v1",
      )) ?? {};
    await f.old.storage.put(
      "native-pool-memberships-v1",
      Object.fromEntries(
        Object.entries(memberships).map(([pool, state]) => [
          pool,
          { ...state, retired: { resumeAfter: now + 3_600_000 } },
        ]),
      ),
    );
    const alarms = new PoolAlarms(f.old.storage, () => now);
    await alarms.schedule("home", now);
    now += 1;
    await alarms.take();
    for (let pass = 0; pass < 3; pass++) {
      await alarms.schedule("fleet", now);
      await f.alarm();
      await f.settle();
      assert.equal(
        (await alarms.inspect()).homeDeadline,
        null,
        "a fleet alarm never re-arms a Home with nothing to renew",
      );
      now += 2_000;
    }
  },
);
