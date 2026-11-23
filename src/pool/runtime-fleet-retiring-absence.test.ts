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
  assert.notEqual(
    row?.phase,
    "retiring",
    "still retiring after an hour with no bound and no reason",
  );
});

test("a stopped cell the provider still lists as running for a while ends on a later pass, never quarantined", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet({ idleMilliseconds: 1_000 });
  // A container that exited stays listed running for about 10 s, so the first reads refuse it.
  let reads = 0;
  const cell = await f.add({ retired: async () => ++reads > 5 });
  const rows = await f.quiet(5 * 60_000);
  assert.ok(reads > 5, "the listing was read again after its first refusals");
  assert.equal(
    rows.find((value) => value.target.slotId === cell.slotId),
    undefined,
    "the row did not end once absence proved",
  );
});
