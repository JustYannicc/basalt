import assert from "node:assert/strict";
import { test } from "node:test";
import { homePassWorker } from "../../scripts/pool-tests/home-pass-worker.ts";
import { membershipRefreshMs } from "./membership-contract.ts";

// Lets every queued step of the alarm's work run as far as it can, with no clock involved.
const drain = async () => {
  for (let turn = 0; turn < 500; turn++) await new Promise<void>((done) => setImmediate(done));
};

test("an alarm that finds a renewal still installing joins it and never installs a second at once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-22T12:00:00Z") });
  for (const method of ["info", "log", "warn", "error"] as const)
    t.mock.method(console, method, () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
  // A fresh controller's first pass refreshes from a read; the next pass only renews the lease.
  // The renewal's install, the second one, is held until the test lets it go.
  let release!: () => void;
  let entered!: () => void;
  const installing = new Promise<void>((done) => {
    entered = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  let install = 0;
  const f = await homePassWorker({
    holdInstalls: () => {
      if (++install !== 2) return undefined;
      entered();
      return held;
    },
  });
  t.after(f.close);
  try {
    await f.worker.alarm();
    await f.settle();
    assert.equal(f.installs.started, 1, "precondition: the first pass refreshed and installed");
    t.mock.timers.setTime(f.started + membershipRefreshMs);
    await f.worker.alarm();
    await installing;
    assert.equal(f.installs.started, 2, "precondition: the next pass is renewing");
    for (const at of [2 * membershipRefreshMs, 3 * membershipRefreshMs]) {
      t.mock.timers.setTime(f.started + at);
      await f.worker.alarm();
      await drain();
    }
    assert.equal(f.installs.started, 2, "an alarm during a renewal joins it");
    release();
    await f.settle();
    // Once the renewal finished, the next Home deadline renews again, one install at a time.
    t.mock.timers.setTime(f.started + 4 * membershipRefreshMs);
    await f.worker.alarm();
    await f.settle();
    assert.ok(f.installs.started >= 3, "the next deadline renews");
    assert.equal(f.installs.maxInFlight, 1);
  } finally {
    release();
    await f.settle();
  }
});
