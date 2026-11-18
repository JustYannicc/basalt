import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { freezeVerdict } from "./freeze.ts";
import { releaseHealth, type Deployment, type Merge } from "./release-health.ts";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/production-2026-11.json", import.meta.url), "utf8"),
);
const deployments: Deployment[] = recorded.deployments.map(
  ([sha, createdAt, committedAt, state]: [string, string, string, Deployment["state"]]) => ({
    sha,
    createdAt,
    committedAt,
    state,
  }),
);
const merges: Merge[] = recorded.merges.map(([number, mergedAt]: [number, string]) => ({
  number,
  mergedAt,
}));
const justBefore = (merge: Merge) =>
  releaseHealth(deployments, merges, new Date(Date.parse(merge.mergedAt) - 1000));

test("would have held 182 of the 677 merges of 5-18 Nov, inside the two spirals and the stuck 5 Nov", () => {
  const held = merges.filter((merge) => justBefore(merge).freeze);
  assert.equal(held.length, 182);
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
  // From 16 Nov 17:38, when the freeze began, every one of the 56 merges would have needed to be
  // a release-path change or labelled release-unblock.
  const spiral = merges.filter((merge) => merge.mergedAt > "2026-11-16T17:38:00Z");
  assert.equal(spiral.length, 56);
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
