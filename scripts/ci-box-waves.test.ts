import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boxSettings,
  boxWaves,
  checkFloor,
  fillBox,
  fullCheckFloor,
  planBox,
  waveSlowdown,
  type BoxShard,
} from "./ci/box-router.ts";

const row = (id: string, minutes: number, timeout = 60): BoxShard => ({ id, minutes, timeout });
const waves = (rows: readonly BoxShard[], free: number, floor: number) =>
  planBox(rows, free, floor).map(({ id, wave }) => ({ id, wave }));

test("free slots take the longest jobs at once, and a second wave waits only if it ends by the floor", () => {
  const rows = [row("a", 15), row("b", 13), row("c", 10), row("d", 7), row("e", 4), row("f", 2)];
  // Two slots: a ends at 18.75 and b at 16.25 at the keep rule's pace. Behind b, c, d and e would
  // end at 28.75, 25 and 21.25, past the 20-minute floor; f ends at 18.75 and waits.
  assert.equal(waveSlowdown, 1.25);
  assert.deepEqual(waves(rows, 2, 20), [
    { id: "a", wave: 1 },
    { id: "b", wave: 1 },
    { id: "f", wave: 2 },
  ]);
  // A later floor lets more wait, never more than two jobs a slot.
  const late = planBox(rows, 2, 60);
  // Each planned job carries the minutes box-watch's deadline needs.
  assert.deepEqual(
    late.map((job) => job.minutes),
    late.map((job) => rows.find((r) => r.id === job.id)!.minutes),
  );
  assert.equal(late.length, 2 * boxWaves);
  assert.deepEqual(
    late.filter((job) => job.wave === 1).map((job) => job.id),
    ["a", "b"],
  );
  // No floor, no free slot or a zero floor: only the first wave, which is the old fill.
  assert.deepEqual(waves(rows, 2, 0), [
    { id: "a", wave: 1 },
    { id: "b", wave: 1 },
  ]);
  assert.deepEqual(fillBox(rows, 2), ["a", "b"]);
  assert.deepEqual(waves(rows, 0, 60), []);
});

test("the second wave fails towards GitHub: unknown minutes or an unknown floor take no waiting job", () => {
  const rows = [row("a", 10), row("b", Number.NaN), row("c", 1)];
  // b has no planned minutes: it fails its timeout check and never routes.
  assert.deepEqual(waves(rows, 1, 60), [
    { id: "a", wave: 1 },
    { id: "c", wave: 2 },
  ]);
  for (const floor of [Number.NaN, -1, 0])
    assert.deepEqual(waves(rows, 1, floor), [{ id: "a", wave: 1 }], String(floor));
  // A row that would overrun its own timeout at the slow end goes hosted in either wave.
  assert.deepEqual(waves([row("a", 10), row("slow", 3, 5)], 1, 60), [{ id: "a", wave: 1 }]);
});

test("a full suite's floor is the full Check's; a fast lane's is its longest routable job", () => {
  assert.equal(checkFloor([row("declared-cloud-1", 9), row("fast", 15.6)]), fullCheckFloor);
  assert.equal(checkFloor([row("declared-cloud-1", 30)]), 30);
  assert.equal(checkFloor([row("fast", 15.6), row("client-connection", 5.3)]), 15.6);
  assert.equal(checkFloor([]), 0);
});

test("a re-run never routes, so attempt 2 sends nothing to the box even when the box is back", () => {
  const settings = {
    event: "push",
    ref: "refs/heads/main",
    slots: "6",
    label: "basalt-box",
    repository: "owner/repo",
  };
  assert.equal(typeof boxSettings({ ...settings, attempt: "1" }), "object");
  for (const attempt of ["2", "3"])
    assert.equal(boxSettings({ ...settings, attempt }), "a re-run always runs hosted", attempt);
});
