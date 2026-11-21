import assert from "node:assert/strict";
import { test } from "node:test";
import { versionsCreatedBetween } from "./stage-versions.ts";

const at = (iso: string) => Date.parse(iso);
const versions = [
  { id: "v1", number: 1, metadata: { created_on: "2026-11-21T10:00:00Z" } },
  { id: "v2", number: 2, metadata: { created_on: "2026-11-21T10:05:00Z" } },
  { id: "v3", number: 3, metadata: { created_on: "2026-11-21T10:06:30Z" } },
  { id: "", number: 4, metadata: { created_on: "2026-11-21T10:06:40Z" } },
  { id: "v5", number: 5, metadata: {} },
];

test("an apply's window counts exactly the versions it created", () => {
  // Two versions inside one apply's window: the defect lane 5's red run reproduces.
  assert.deepEqual(
    versionsCreatedBetween(versions, at("2026-11-21T10:04:00Z"), at("2026-11-21T10:07:00Z")).map(
      (version) => version.number,
    ),
    [2, 3],
  );
  // None: a release that leaves the pool Worker's code unchanged.
  assert.equal(
    versionsCreatedBetween(versions, at("2026-11-21T10:01:00Z"), at("2026-11-21T10:04:00Z")).length,
    0,
  );
  // Rows with no id or no creation time are never counted.
  assert.equal(
    versionsCreatedBetween(versions, at("2026-11-21T09:00:00Z"), at("2026-11-21T11:00:00Z")).length,
    3,
  );
});
