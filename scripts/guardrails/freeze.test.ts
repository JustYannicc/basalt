import assert from "node:assert/strict";
import { test } from "node:test";
import { freezeVerdict } from "./freeze.ts";
import { releaseHealth, type Merge } from "./release-health.ts";
import { deployments, merges } from "./test/history.ts";

const justBefore = (merge: Merge) =>
  releaseHealth(deployments, merges, new Date(Date.parse(merge.mergedAt) - 1000));

test("would have held 173 of the 677 merges of 5-18 Nov, all while releases were stuck", () => {
  const held = merges.filter((merge) => justBefore(merge).freeze);
  assert.equal(held.length, 173);
  const days = new Set(held.map((merge) => merge.mergedAt.slice(0, 10)));
  assert.deepEqual(
    [...days],
    [
      "2026-11-05",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
    ],
  );
  // From 16 Nov 19:29, when the freeze began, every one of the 55 merges would have needed to be
  // a release-path change or labelled release-unblock.
  const spiral = merges.filter((merge) => merge.mergedAt > "2026-11-16T19:29:00Z");
  assert.equal(spiral.length, 55);
  assert.ok(spiral.every((merge) => justBefore(merge).freeze));
});

const frozen = { freeze: true, waitingHours: 30.2, hoursSinceLastGood: 31 };

test("a frozen main still takes release-path changes and labelled unblocks", () => {
  assert.equal(freezeVerdict(frozen, ["scripts/release/deploy.ts"], []).pass, true);
  assert.equal(freezeVerdict(frozen, ["src/pool/worker.ts"], ["release-unblock"]).pass, true);
  const feature = freezeVerdict(frozen, ["src/pool/worker.ts"], []);
  assert.equal(feature.pass, false);
  assert.match(feature.description, /waited 30.2 h/);
  assert.ok(feature.description.length <= 140);
});

test("mixing the release path with feature work does not count as release-path only", () => {
  assert.equal(
    freezeVerdict(frozen, ["scripts/release/deploy.ts", "src/pool/worker.ts"], []).pass,
    false,
  );
});

test("a current main passes everything", () => {
  const current = { freeze: false, waitingHours: 2, hoursSinceLastGood: 1 };
  assert.equal(freezeVerdict(current, ["src/pool/worker.ts"], []).pass, true);
});
