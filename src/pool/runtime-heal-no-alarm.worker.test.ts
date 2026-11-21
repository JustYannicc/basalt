import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { unservingBoundMs } from "./runtime-slots/forced-restart-timing.ts";
import { membershipTtlMs } from "./membership-contract.ts";
import type { MembershipState } from "./membership-state.ts";
import { nativeMembershipKey } from "./runtime-slots/storage.ts";
import { PoolAlarms } from "./alarms.ts";

// The stuck record heals from the pool's own alarms and a healing release's calls alone: no
// test-armed pass, as on production after a code upload.
type Fixture = Awaited<ReturnType<typeof fleetWorkerFixture>>;
interface Inspected {
  selection: { epoch: number; active: { identity: { bootId: string } } };
}

async function passes(f: Fixture, count: number) {
  for (let pass = 0; pass < count; pass++) {
    await f.upkeep();
    await f.settle();
  }
}

async function stuck(context: TestContext) {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  context.mock.method(console, "info", () => {});
  const errors = context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  f.old.crash();
  await passes(f, 1);
  const previous = f.old.identity();
  const epoch = ((await f.send("inspect")) as Inspected).selection.epoch;
  const start = f.old.ctx.container.start.bind(f.old.ctx.container);
  f.old.crash();
  f.old.ctx.container.start = () => {
    f.old.revive();
    throw new Error("synthetic: the previous container is still running");
  };
  await passes(f, 1);
  f.old.ctx.container.start = start;
  await passes(f, 3);
  now += 3_600_000;
  // The old code kept no recovery clock row.
  await f.send("recovery-reset", { operationId: "incident-release" });
  return { f, previous, epoch, errors, advance: (ms: number) => (now += ms) };
}

/** A healing release after its upload: readiness and acceptance's inspect every 5 s, nothing else. */
async function healingRelease(
  f: Fixture,
  worker: { deploymentReady(): Promise<unknown> },
  advance: (ms: number) => void,
  withinMs: number,
) {
  const fired: number[] = [];
  for (let elapsed = 0; elapsed <= withinMs; elapsed += 1_000) {
    if (elapsed % 5_000 === 0) {
      await worker.deploymentReady().catch(() => {});
      await f.send("inspect");
    }
    // Only an alarm the pool armed itself fires.
    const at = await f.old.storage.getAlarm();
    if (at !== null && at <= Date.now()) {
      fired.push(elapsed);
      await f.alarm();
    }
    await f.settle();
    advance(1_000);
  }
  return fired;
}

async function healed(f: Fixture, previous: { bootId: string }, epoch: number) {
  const { selection } = (await f.send("inspect")) as Inspected;
  const health = await f.command("active-health");
  await health.body?.cancel();
  return {
    epoch: selection.epoch - epoch,
    newBoot: selection.active.identity.bootId !== previous.bootId,
    activeHealth: health.status,
  };
}

const within = unservingBoundMs + 300_000;

/** Counts the alarm passes that ran each owner: Home, and the fleet, whose upkeep runs recovery. */
function duePasses(context: TestContext) {
  const take = PoolAlarms.prototype.take;
  const count = { home: 0, fleet: 0 };
  context.mock.method(PoolAlarms.prototype, "take", async function (this: PoolAlarms) {
    const due = await take.call(this);
    if (due.home) count.home++;
    if (due.fleet) count.fleet++;
    return due;
  });
  return () => ({ ...count });
}

/** Fires the pool's alarm when it armed one that is due, as the platform would. */
async function fireDue(f: Fixture) {
  await f.settle();
  const at = await f.old.storage.getAlarm();
  if (at !== null && at <= Date.now()) await f.alarm();
  await f.settle();
  return at;
}

test(
  "a fresh object with no selected runtime arms nothing and runs no Home pass on its first inbound call",
  { timeout: 60_000 },
  async (context) => {
    context.mock.method(console, "info", () => {});
    context.mock.method(console, "error", () => {});
    context.mock.method(console, "warn", () => {});
    const f = await fleetWorkerFixture({ adopt: false });
    context.after(f.cleanup);
    await f.old.storage.delete("fixture-alarm");
    await f.old.storage.delete("pool-alarm-v1:deadlines");
    await f.settle();
    const passes = duePasses(context);
    // A new object whose first event is an inbound call. On a pool app's view that call reads the
    // change revisions; a Home pass inside it moves them, and the view runs its query twice.
    f.reconstruct();
    const inspected = (await f.send("inspect")) as { selection?: unknown };
    assert.equal(inspected.selection, undefined, "no runtime is selected");
    assert.equal(await fireDue(f), null, "no alarm is armed");
    assert.deepEqual(passes(), { home: 0, fleet: 0 }, "no upkeep pass ran");
  },
);

test(
  "an object with a selection and no alarm, as after an upload resets it, arms on its first inbound call and its first pass starts at once",
  { timeout: 120_000 },
  async (context) => {
    const { f, advance } = await stuck(context);
    await f.old.storage.delete("fixture-alarm");
    await f.old.storage.delete("pool-alarm-v1:deadlines");
    await f.settle();
    assert.equal(await f.old.storage.getAlarm(), null, "no alarm is armed");
    advance(5_000);
    const passes = duePasses(context);
    // The release's readiness read is the first inbound call after the upload.
    const worker = f.reconstruct();
    await worker.deploymentReady().catch(() => {});
    const at = await fireDue(f);
    assert.ok(at !== null && at <= Date.now(), "armed for now, not later");
    assert.deepEqual(passes(), { home: 1, fleet: 1 }, "the first pass, recovery's, ran at once");
  },
);

test(
  "the stuck record with its alarm still armed heals from the pool's own alarms",
  { timeout: 120_000 },
  async (context) => {
    const { f, previous, epoch, advance } = await stuck(context);
    assert.notEqual(await f.old.storage.getAlarm(), null, "an alarm is armed");
    const fired = await healingRelease(f, f.worker, advance, within);
    assert.ok(fired.length > 0, "the pool's alarm fired");
    assert.deepEqual(await healed(f, previous, epoch), {
      epoch: 1,
      newBoot: true,
      activeHealth: 200,
    });
  },
);

test(
  "a long-lived object whose alarm was lost heals from a healing release's calls alone",
  { timeout: 120_000 },
  async (context) => {
    const { f, previous, epoch, advance } = await stuck(context);
    await f.old.storage.delete("fixture-alarm");
    await f.old.storage.delete("pool-alarm-v1:deadlines");
    await f.settle();
    assert.equal(await f.old.storage.getAlarm(), null, "no alarm is armed");
    // No new object: the release's readiness read and inspect must arm it themselves.
    const fired = await healingRelease(f, f.worker, advance, within);
    assert.ok(fired.length > 0, "an alarm the pool armed itself fired");
    assert.deepEqual(await healed(f, previous, epoch), {
      epoch: 1,
      newBoot: true,
      activeHealth: 200,
    });
  },
);

test(
  "the stuck record with no alarm armed heals from a healing release's calls alone",
  { timeout: 120_000 },
  async (context) => {
    const { f, previous, epoch, advance } = await stuck(context);
    await f.old.storage.delete("fixture-alarm");
    await f.old.storage.delete("pool-alarm-v1:deadlines");
    assert.equal(await f.old.storage.getAlarm(), null, "no alarm is armed");
    // The healing release's upload: a new object over the same storage, as after a code update.
    advance(5_000);
    const fired = await healingRelease(f, f.reconstruct(), advance, within);
    assert.ok(fired.length > 0, "an alarm the pool armed itself fired");
    assert.deepEqual(await healed(f, previous, epoch), {
      epoch: 1,
      newBoot: true,
      activeHealth: 200,
    });
  },
);

/** A pool that is not ready, whose first Home pass after the upload changes its membership row. */
const unreadyPool = (): Record<string, MembershipState> => ({
  "unready-pool": {
    pool: "unready-pool",
    organization: "other-organization",
    revision: 5,
    accounts: [],
    dirty: true,
    expiresAt: Date.now() + membershipTtlMs,
    native: false,
    checkedAt: Date.now(),
    installedRevision: 5,
    installedUntil: Date.now() + membershipTtlMs,
  },
});

test(
  "a fresh object's first Home pass that changes a pool makes recovery refuse that pass, and a later one commits",
  { timeout: 120_000 },
  async (context) => {
    const { f, previous, epoch, errors, advance } = await stuck(context);
    const rows = (await f.old.storage.get<Record<string, MembershipState>>(nativeMembershipKey))!;
    await f.old.storage.put(nativeMembershipKey, { ...rows, ...unreadyPool() });
    await f.old.storage.delete("fixture-alarm");
    await f.old.storage.delete("pool-alarm-v1:deadlines");
    await f.settle();
    assert.equal(await f.old.storage.getAlarm(), null, "no alarm is armed");
    // The healing release's upload: a new object arms Home and fleet together on its first event.
    advance(5_000);
    errors.mock.resetCalls();
    const fired = await healingRelease(f, f.reconstruct(), advance, within);
    assert.ok(fired.length > 0, "an alarm the pool armed itself fired");
    assert.deepEqual(await healed(f, previous, epoch), {
      epoch: 1,
      newBoot: true,
      activeHealth: 200,
    });
    const after = (await f.old.storage.get<Record<string, MembershipState>>(nativeMembershipKey))!;
    assert.ok(
      after["unready-pool"]!.revision > 5,
      "Home's pass changed the pool, moving the digest",
    );
    const refusals = errors.mock.calls.filter((call) => {
      if (call.arguments[0] !== "POOL_SELECTED_RECOVERY_PENDING") return false;
      const line = JSON.parse(String(call.arguments[1])) as { reason?: string };
      return line.reason === "slot_selection";
    });
    assert.equal(refusals.length, 1, "refused once, on the pass under the moving digest");
  },
);
