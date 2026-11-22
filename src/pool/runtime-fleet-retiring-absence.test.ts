import assert from "node:assert/strict";
import { test } from "node:test";
import { quietFleet } from "../../scripts/pool-tests/runtime-fleet-quiet-fixture.ts";

test("a retiring cell whose provider absence never arrives leaves retiring within a bound", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet({ idleMilliseconds: 1_000 });
  const cell = await f.add({ retired: async () => false });
  const rows = await f.quiet(60 * 60_000);
  const row = rows.find((value) => value.target.slotId === cell.slotId);
  assert.equal(f.calls.retires, 1, "retirement began once");
  assert.notEqual(row?.phase, "retiring", "still retiring after an hour with no bound and no reason");
});
