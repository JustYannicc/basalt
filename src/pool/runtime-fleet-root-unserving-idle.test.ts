import assert from "node:assert/strict";
import { test } from "node:test";
import { quietFleet } from "../../scripts/pool-tests/runtime-fleet-quiet-fixture.ts";
import { fleetRouting } from "./runtime-fleet/production.ts";

test("the last ready cell is kept while the root cannot serve, so the first call after a quiet minute is served", async (context) => {
  context.mock.method(console, "info", () => {});
  let rootServes = false;
  const f = quietFleet({
    primary: fleetRouting.primary,
    primaryAvailable: () => rootServes,
    legacy: async () => {
      throw new Error("The pool runtime is temporarily unhealthy");
    },
  });
  const cell = await f.add();
  const first = await f.call();
  await first.body!.cancel();
  await f.settle();
  const rows = await f.quiet(5 * 60_000);
  assert.deepEqual(
    rows.map((value) => [value.target.slotId, value.phase]),
    [[cell.slotId, "ready"]],
    "the only serving runtime was retired while the root could not serve",
  );
  const after = await f.call();
  assert.equal(after.status, 200);
  await after.body!.cancel();
  rootServes = true;
});
