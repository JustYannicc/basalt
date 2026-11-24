import assert from "node:assert/strict";
import { test } from "node:test";
import { quietFleet } from "../../scripts/pool-tests/runtime-fleet-quiet-fixture.ts";

test("a cell whose start never activates leaves the starting states within a bound and frees its slot", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet();
  const stuck = await f.reserve({
    start: async () => {
      throw new Error("The pool did not become ready within the startup budget");
    },
    observe: async () => {
      throw new Error("The pool runtime is temporarily unhealthy");
    },
  });
  // An hour of quiet alarms at the fleet's two-second cadence: no call, no person.
  const rows = await f.quiet(60 * 60_000);
  const row = rows.find((value) => value.target.slotId === stuck.slotId);
  assert.ok(
    !row || !["reserved", "warming", "uncertain"].includes(row.phase),
    `still ${row?.phase} after an hour with no bound and no reason`,
  );
  assert.equal(
    await f.state.physicalCount(),
    0,
    "a start that never activated still holds one of the fleet's physical slots",
  );
});
