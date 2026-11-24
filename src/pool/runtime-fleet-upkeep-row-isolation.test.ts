import assert from "node:assert/strict";
import { test } from "node:test";
import { quietFleet } from "../../scripts/pool-tests/runtime-fleet-quiet-fixture.ts";

test("one cell whose observation keeps failing does not stop upkeep for the cells after it", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet({ idleMilliseconds: 60_000 });
  await f.reserve({
    start: async () => {
      throw new Error("The pool did not become ready within the startup budget");
    },
    observe: async () => {
      throw new Error("The pool runtime is temporarily unhealthy");
    },
  });
  const idle = await f.add();
  // Ten quiet minutes: the idle cell is far past its 60 s bound and nothing calls.
  const rows = await f.quiet(10 * 60_000);
  assert.equal(
    rows.find((value) => value.target.slotId === idle.slotId)?.phase,
    undefined,
    "the idle cell behind the failing one was never drained or retired",
  );
});
