import assert from "node:assert/strict";
import { test } from "node:test";
import { quietFleet } from "../../scripts/pool-tests/runtime-fleet-quiet-fixture.ts";

// A stream's ledger release runs in the controller isolate that admitted it. When the platform
// replaces that isolate mid-stream, the release never runs, while the cell itself sees the stream end.

test("a draining cell whose only stream release was lost retires once the cell reports no activity", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet();
  const cell = await f.add();
  await f.call();
  f.restart();
  await f.fleet.drain(cell);
  const rows = await f.quiet(60 * 60_000);
  assert.equal(
    rows.find((value) => value.target.slotId === cell.slotId)?.phase,
    undefined,
    "still draining after an hour although the cell reports zero activity",
  );
});

test("a ready cell whose only stream release was lost still goes idle", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = quietFleet();
  const cell = await f.add();
  await f.call();
  f.restart();
  const rows = await f.quiet(60 * 60_000);
  assert.equal(
    rows.find((value) => value.target.slotId === cell.slotId)?.phase,
    undefined,
    "still ready with a phantom active stream after an hour of quiet",
  );
});
