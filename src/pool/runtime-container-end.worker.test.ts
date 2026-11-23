import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";

function quiet(context: TestContext) {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
}

test("the primary a recovery replaced keeps how it ended, and the controller inspect returns it", async (context) => {
  quiet(context);
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  const previous = f.old.identity();
  // Killed, not stopped by us: the platform hands the monitor its exit.
  f.old.ctx.container.signal(9);
  for (let pass = 0; pass < 3; pass++) {
    await f.upkeep();
    await f.settle();
  }
  const inspected = (await f.send("inspect")) as {
    selection: { active: { identity: { bootId: string } } };
    lastEnd?: { previous: { bootId: string }; end: { at: number } } | null;
  };
  assert.notEqual(inspected.selection.active.identity.bootId, previous.bootId, "recovered");
  assert.equal(inspected.lastEnd?.previous.bootId, previous.bootId);
  // The fixture's kill resolves the monitor, the platform's rejects with 137; the unit tests pin that.
  const end = inspected.lastEnd?.end as
    | { cause?: string; seen?: string; stopSent?: true }
    | undefined;
  assert.equal(end?.cause, "exit");
  assert.equal(end?.seen, "monitor");
  assert.equal(end?.stopSent, undefined, "a kill we didn't send read as our stop");
});

test("a cell we retire ends with our stop mark, never as a crash", async (context) => {
  quiet(context);
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  const selected = await f.cell.start(f.target);
  assert.deepEqual(await f.cell.drain(selected), { active: 0, known: true });
  assert.equal(await f.cell.retire(selected, async () => {}), true);
  await f.settle();
  const end = f.cell.lastEnd(selected);
  assert.equal(end?.seen, "monitor");
  assert.equal(end?.stopSent, true, "a stop we sent read as a crash");
});

test("a monitor's outcome alone decides nothing: with running held true, a rejection with no exit records unknown and nothing starts, stops or recovers", async (context) => {
  quiet(context);
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  const primary = f.old.identity();
  const before = { ...f.old.calls, signals: [...f.old.calls.signals] };
  // The monitor's transport is lost; the container runs on and answers its health reads. `running`
  // is held true, which the platform never does, so only the monitor's outcome could act.
  f.old.loseMonitor(new Error("Network connection lost."), { runningStays: true });
  for (let pass = 0; pass < 3; pass++) {
    await f.upkeep();
    await f.settle();
  }
  const inspected = (await f.send("inspect")) as {
    selection: { active: { identity: { bootId: string } } };
    lastEnd?: unknown;
  };
  assert.equal(inspected.selection.active.identity.bootId, primary.bootId, "the primary recovered");
  assert.equal(inspected.lastEnd ?? null, null);
  assert.equal(f.old.calls.start, before.start, "a start followed the monitor");
  assert.equal(f.old.calls.destroy, before.destroy, "a destroy followed the monitor");
  assert.deepEqual(f.old.calls.signals, before.signals, "a stop followed the monitor");
  const record = await f.old.storage.get<{ current: { end?: { at: number } } }>(
    "runtime-container-end-v1",
  );
  const { at, ...end } = record?.current.end ?? { at: undefined };
  assert.equal(typeof at, "number");
  assert.deepEqual(end, { exitCode: null, cause: "unknown", seen: "monitor" });
});

test("a lost monitor reads running false as on the platform, and upkeep decides the same with the end watch as without it", async (context) => {
  quiet(context);
  const passes = async (lose: (f: Awaited<ReturnType<typeof fleetWorkerFixture>>) => void) => {
    const f = await fleetWorkerFixture();
    context.after(f.cleanup);
    await f.bootstrap();
    const primary = f.old.identity();
    const before = { ...f.old.calls, signals: [...f.old.calls.signals] };
    lose(f);
    for (let pass = 0; pass < 3; pass++) {
      await f.upkeep();
      await f.settle();
    }
    const inspected = (await f.send("inspect")) as {
      selection: { active: { identity: { bootId: string } } };
    };
    return {
      recovered: inspected.selection.active.identity.bootId !== primary.bootId,
      starts: f.old.calls.start - before.start,
      destroys: f.old.calls.destroy - before.destroy,
      signals: f.old.calls.signals.slice(before.signals.length),
    };
  };
  // The end watch hears the rejection and writes its record ...
  const watched = await passes((f) => f.old.loseMonitor(new Error("Network connection lost.")));
  // ... or never settles: the same platform state with nothing from the watch.
  const unwatched = await passes((f) => f.old.crash());
  assert.deepEqual(watched, unwatched);
});
