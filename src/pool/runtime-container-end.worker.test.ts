import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { fleetCellFixture } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";

function quiet(context: TestContext) {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
}
const withoutTime = (end: { at: number } | undefined) => {
  if (!end) return end;
  const { at: _at, ...rest } = end;
  return rest;
};

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
  assert.deepEqual(withoutTime(inspected.lastEnd?.end), {
    exitCode: 0,
    cause: "exit",
    seen: "monitor",
  });
});

test("a cell we retire ends with our stop mark, never as a crash", async (context) => {
  quiet(context);
  const f = await fleetCellFixture();
  context.after(f.cleanup);
  const selected = await f.cell.start(f.target);
  assert.deepEqual(await f.cell.drain(selected), { active: 0, known: true });
  assert.equal(await f.cell.retire(selected, async () => {}), true);
  await f.settle();
  assert.deepEqual(withoutTime(f.cell.lastEnd(selected)), {
    exitCode: 0,
    cause: "exit",
    seen: "monitor",
    stopSent: true,
  });
});
