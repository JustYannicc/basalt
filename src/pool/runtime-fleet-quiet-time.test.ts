import assert from "node:assert/strict";
import { test } from "node:test";
import { quietFleet } from "../../scripts/pool-tests/runtime-fleet-quiet-fixture.ts";

// Every test here lets time pass with nothing else going on: the fleet's own alarm is the only
// actor, as on production between calls.

test("a cell used a moment ago stays ready up to its idle bound, then drains and retires in quiet passes", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet({ idleMilliseconds: 120_000 });
  const cell = await f.add();
  const answer = await f.call();
  await answer.body!.cancel();
  await f.settle();
  const used = (await f.state.inspect())[0]!.lastUsedAt;
  assert.equal(used, f.now());
  // Past the 60 s recent-demand window, the idle bound alone keeps it.
  let rows = await f.pass(119_999);
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["ready"],
    "one millisecond before the idle bound the cell still serves",
  );
  rows = await f.pass(1);
  assert.deepEqual(
    rows.map((row) => [row.target.slotId, row.phase]),
    [[cell.slotId, "draining"]],
    "at the idle bound the cell drains",
  );
  rows = await f.pass();
  assert.equal(rows.length, 0, "the next quiet pass retires it");
  assert.equal(f.calls.retires, 1);
  assert.equal(f.calls.failedPasses, 0);
});

test("recent demand keeps the last ready cell for 60 s after the last call, then lets it go", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet({ idleMilliseconds: 1_000 });
  await f.add();
  const answer = await f.call();
  await answer.body!.cancel();
  await f.settle();
  let rows = await f.pass(59_999);
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["ready"],
    "inside the recent-demand window an idle cell is kept",
  );
  rows = await f.pass(1);
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["draining"],
    "60 s after the last call the idle cell drains",
  );
  rows = await f.pass();
  assert.equal(rows.length, 0);
  assert.equal(f.calls.starts, 0, "an idle fleet starts nothing while it shrinks");
});

test("a second ready cell is not held by recent demand: only the first one is kept", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet({ idleMilliseconds: 1_000 });
  const first = await f.add();
  await f.add();
  const answer = await f.call();
  await answer.body!.cancel();
  await f.settle();
  await f.pass(1_000);
  let rows = await f.pass();
  assert.deepEqual(
    rows.map((row) => [row.target.slotId, row.phase]),
    [[first.slotId, "ready"]],
    "the extra cell retires inside the demand window, the first one serves on",
  );
  rows = await f.pass(60_000);
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["draining"],
  );
  assert.equal((await f.pass()).length, 0);
});

test("a first start that misses its deadline is observed on the next quiet pass and becomes ready", async (context) => {
  const info = context.mock.method(console, "info", () => {});
  const f = quietFleet();
  let activated = false;
  const slot = await f.reserve({
    start: async () => {
      throw new Error("The pool did not become ready within the startup budget");
    },
    observe: async (target) => (activated ? { ...target, bootId: "boot-late" } : undefined),
  });
  let rows = await f.pass();
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["uncertain"],
    "a start with no answer is uncertain, never assumed lost",
  );
  assert.equal(f.calls.failedPasses, 0, "the row's failure settles for that row; the pass goes on");
  assert.equal(f.calls.starts, 1, "the same pass dispatched the reserved row's start");
  assert.ok(
    info.mock.calls.some(({ arguments: [line, fields] }) => {
      const value = fields as { phase?: string; outcome?: string; ordinal?: number } | undefined;
      return (
        line === "POOL_RUNTIME_UPKEEP" &&
        value?.phase === "reserved" &&
        value.outcome === "error" &&
        value.ordinal === 1
      );
    }),
    "the start's failure is recorded for its row",
  );
  rows = await f.pass();
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["uncertain"],
  );
  activated = true;
  rows = await f.pass();
  assert.deepEqual(
    rows.map((row) => [row.target.slotId, row.phase, row.identity?.bootId]),
    [[slot.slotId, "ready", "boot-late"]],
  );
  assert.equal(f.calls.starts, 1, "observation never starts compute a second time");
});

test("a reserved cell is started by the next quiet pass without any call", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet();
  const slot = await f.reserve();
  const rows = await f.pass();
  assert.deepEqual(
    rows.map((row) => [row.target.slotId, row.phase]),
    [[slot.slotId, "ready"]],
  );
  assert.equal(f.calls.starts, 1);
});
