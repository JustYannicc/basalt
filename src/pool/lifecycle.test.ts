import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicModelPath, PoolLifecycle, poolLifecycle, poolPort, type RuntimeDriver, type RuntimeStorage } from "./lifecycle.ts";

function fixture() {
  let time = 0;
  let running = false;
  let revision: string | undefined;
  let alarm: number | null = null;
  let starts = 0;
  let stops = 0;
  const timeouts: number[] = [];
  const driver: RuntimeDriver = {
    running: () => running,
    start: () => { running = true; starts += 1; },
    stop: async () => { running = false; stops += 1; },
    keepAlive: async (ms) => { timeouts.push(ms); },
    status: async () => ({ boot_id: `boot-${starts}`, started_at: new Date(time).toISOString() }),
  };
  const storage: RuntimeStorage = {
    get: async <T>() => revision as T | undefined,
    put: async (_key, value) => { revision = value; },
    getAlarm: async () => alarm,
    setAlarm: async (next) => { alarm = next; },
  };
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  return {
    driver, storage, clock, timeouts,
    advance: (ms: number) => { time += ms; },
    expireAlarm: () => { alarm = null; },
    state: () => ({ starts, stops, alarm }),
  };
}

test("concurrent requests share startup and refresh the warm timeout beyond an hour", async () => {
  const f = fixture();
  const runtime = new PoolLifecycle(f.driver, f.storage, "release-a", f.clock);
  const first = await Promise.all([runtime.warm(), runtime.warm()]);
  assert.equal(first[0].boot_id, first[1].boot_id);
  assert.deepEqual(f.state(), { starts: 1, stops: 0, alarm: poolLifecycle.refreshMs });
  assert.ok(f.timeouts[0]! > 60 * 60_000);
  for (let minute = 0; minute < 65; minute += 5) {
    f.advance(5 * 60_000);
    f.expireAlarm();
    assert.equal((await runtime.warm()).boot_id, first[0].boot_id);
  }
  assert.equal(f.state().starts, 1);
});

test("DO eviction keeps a running container; a changed secret/image revision restarts it", async () => {
  const f = fixture();
  const first = await new PoolLifecycle(f.driver, f.storage, "release-a", f.clock).warm();
  const afterEviction = await new PoolLifecycle(f.driver, f.storage, "release-a", f.clock).warm();
  assert.equal(afterEviction.boot_id, first.boot_id);
  const rotated = await new PoolLifecycle(f.driver, f.storage, "release-b", f.clock).warm();
  assert.notEqual(rotated.boot_id, first.boot_id);
  assert.equal(f.state().starts, 2);
  assert.equal(f.state().stops, 1);
});

test("startup waits for readiness and schedules recovery when the process exits", async () => {
  const f = fixture();
  let probes = 0;
  f.driver.status = async () => {
    if (++probes < 3) throw new Error("not ready");
    return { boot_id: "ready", started_at: "2026-01-01T00:00:00Z" };
  };
  const runtime = new PoolLifecycle(f.driver, f.storage, "release-a", f.clock);
  assert.equal((await runtime.warm()).boot_id, "ready");
  assert.equal(f.clock.now(), 2_000);
  f.driver.status = async () => { await f.driver.stop(); throw new Error("exited"); };
  await assert.rejects(runtime.warm(), /pool exited during startup/);
  assert.ok(f.state().alarm !== null);
});

test("an unready container has a bounded wait and leaves a recovery alarm", async () => {
  const f = fixture();
  f.driver.status = async () => { throw new Error("not ready"); };
  await assert.rejects(new PoolLifecycle(f.driver, f.storage, "release-a", f.clock).warm(), /startup budget/);
  assert.equal(f.clock.now(), poolLifecycle.startupTimeoutMs);
  assert.equal(f.state().alarm, poolLifecycle.startupTimeoutMs + poolLifecycle.refreshMs);
});

for (const evicted of [false, true]) {
  for (const rotated of [false, true]) {
    test(`a slow boot survives a retry, eviction=${evicted}, rotation=${rotated}`, async () => {
      const f = fixture();
      if (rotated) await new PoolLifecycle(f.driver, f.storage, "release-old", f.clock).warm();
      const readyStatus = f.driver.status;
      let ready = false;
      f.driver.status = async () => {
        if (!ready) throw new Error("still booting");
        return readyStatus();
      };
      const runtime = new PoolLifecycle(f.driver, f.storage, "release-new", f.clock);
      await assert.rejects(runtime.warm(), /startup budget/);
      const launching = f.state();
      ready = true;
      const retry = evicted ? new PoolLifecycle(f.driver, f.storage, "release-new", f.clock) : runtime;
      const status = await retry.warm();
      assert.equal(status.boot_id, `boot-${launching.starts}`);
      assert.equal(f.state().starts, launching.starts, "retry must keep the boot already in progress");
      assert.equal(f.state().stops, launching.stops, "readiness timeout must not trigger another destroy");
    });
  }
}

test("management and model traffic use separate listeners with exact path boundaries", () => {
  assert.equal(poolPort("/v1/responses"), 8317);
  assert.equal(poolPort("/messages"), 8317);
  assert.equal(poolPort("/chat/completions"), 8317);
  assert.equal(poolPort("/completions"), 8317);
  assert.equal(poolPort("/v8/management/credentials"), 8327);
  assert.equal(poolPort("/v0/management"), 8327);
  assert.equal(poolPort("/v8/management-other"), undefined);
  assert.equal(poolPort("/v10/responses"), undefined);
  assert.equal(poolPort("/"), undefined);
});

test("public model gate excludes internal management while preserving its DO listener", () => {
  for (const path of ["/v1", "/v1/", "/v1/models", "/v1/responses", "/messages", "/chat/completions", "/completions"]) {
    assert.equal(isPublicModelPath(path), true, path);
  }
  for (const path of ["/v0/management", "/v8/management/config", "/__warm", "/v10", "/v1foo"]) {
    assert.equal(isPublicModelPath(path), false, path);
  }
  assert.equal(poolPort("/v8/management/config"), 8327);
});
