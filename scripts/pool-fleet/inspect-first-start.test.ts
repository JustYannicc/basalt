import assert from "node:assert/strict";
import { test } from "node:test";
import { runPoolFleet, type DispatchInput } from "./dispatch.ts";
import { colours, harness, type HarnessOptions } from "./test/harness.ts";

const dispatch: DispatchInput = {
  mode: "inspect",
  go: "coordinator-2026-11-27-first-start",
  ref: "refs/heads/main",
  event: "workflow_dispatch",
};
const target = (slot: number) => ({
  format: "pool-runtime-slot-v1" as const,
  controllerId: "controller",
  slotId: `runtime-cell-${slot}`,
  applicationId: colours.blue.id,
  applicationVersion: "1",
  instanceId: String(slot).repeat(64),
  imageDigest: colours.blue.image,
  imageInput: colours.blue.input,
  homePeerOrdinal: slot,
});
const held = (slot: number) => ({
  target: target(slot),
  phase: "quarantined",
  reason: "start_unproven",
  active: 0,
  lastUsedAt: 0,
});
// Three starts held at their bound without a boot, and one admitted cell.
const rows = [
  held(1),
  held(2),
  held(3),
  {
    target: target(4),
    identity: { ...target(4), bootId: "boot-4" },
    phase: "ready",
    active: 0,
    lastUsedAt: 0,
  },
];

/** The lane's inspect over `rows`, as the controller reports them with `inspectedRow`. */
async function printed(inspectedRow?: HarnessOptions["inspectedRow"]) {
  const lane = await harness({ startCell: false, ...(inspectedRow ? { inspectedRow } : {}) });
  try {
    lane.storage.values.set("runtime-fleet-v1:resources", rows);
    const result = await runPoolFleet(dispatch, lane.deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    const fleet = (result as { result: { fleet: { rows: { firstStart: unknown }[] } } }).result
      .fleet;
    return { rows: fleet.rows, text: JSON.stringify(result) };
  } finally {
    await lane.close();
  }
}

test("the inspect lane prints how far each quarantined start without a boot got", async () => {
  const reached: Record<string, string> = {
    [target(1).slotId]: "activated",
    [target(2).slotId]: "attested",
    [target(3).slotId]: "neither",
  };
  const { rows: lines } = await printed((row) =>
    row.phase === "quarantined" && !row.identity ? { firstStart: reached[row.target.slotId] } : {},
  );
  assert.deepEqual(
    lines.map((line) => line.firstStart),
    ["activated", "attested", "neither", null],
  );
});

test("a lane reading a controller on older code, which sends no first start, prints null for it", async () => {
  const { rows: lines } = await printed();
  assert.deepEqual(
    lines.map((line) => line.firstStart),
    [null, null, null, null],
  );
});

test("a lane older than its controller decodes rows carrying values and fields it doesn't know, and prints none of them", async () => {
  const { rows: lines, text } = await printed((row) =>
    row.phase === "quarantined"
      ? { firstStart: "reached-later", laterField: { planted: "planted-row-text" } }
      : { laterField: 1 },
  );
  assert.deepEqual(
    lines.map((line) => line.firstStart),
    [null, null, null, null],
  );
  assert.doesNotMatch(text, /reached-later|laterField|planted-row-text/u);
});
