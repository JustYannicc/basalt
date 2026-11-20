import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { unservingBoundMs } from "./runtime-slots/forced-restart-timing.ts";

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
  context.mock.method(console, "error", () => {});
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
  return { f, previous, epoch, advance: (ms: number) => (now += ms) };
}

/** A healing release after its upload: readiness and acceptance's inspect every 5 s, nothing else. */
async function healingRelease(f: Fixture, advance: (ms: number) => void, withinMs: number) {
  const fired: number[] = [];
  for (let elapsed = 0; elapsed <= withinMs; elapsed += 1_000) {
    if (elapsed % 5_000 === 0) {
      await f.worker.deploymentReady().catch(() => {});
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

test(
  "the stuck record with its alarm still armed heals from the pool's own alarms",
  { timeout: 120_000 },
  async (context) => {
    const { f, previous, epoch, advance } = await stuck(context);
    assert.notEqual(await f.old.storage.getAlarm(), null, "an alarm is armed");
    const fired = await healingRelease(f, advance, within);
    assert.ok(fired.length > 0, "the pool's alarm fired");
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
    const fired = await healingRelease(f, advance, within);
    assert.deepEqual(
      { fired: fired.length, ...(await healed(f, previous, epoch)) },
      { fired: fired.length, epoch: 1, newBoot: true, activeHealth: 200 },
    );
  },
);
