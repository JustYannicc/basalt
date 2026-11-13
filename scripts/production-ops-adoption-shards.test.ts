import assert from "node:assert/strict";
import test from "node:test";
import { scenarios as plans } from "../.upstream/e2e/test-plan.ts";
import { patternForGroup } from "./ci/declarations.ts";
import { adoptionProofSelection } from "./production-ops/adoption-shards.ts";

test("CI shards cover every declared adoption case exactly once and balance each spec", () => {
  const all = adoptionProofSelection(plans, patternForGroup("production-ops:adoption"));
  const shards = ["1/2", "2/2"].map((shard) =>
    adoptionProofSelection(plans, patternForGroup("production-ops:adoption"), shard),
  );
  assert.deepEqual(shards.flatMap((shard) => shard.ids).sort(), [...all.ids].sort());
  assert.equal(new Set(shards.flatMap((shard) => shard.ids)).size, all.ids.length);
  const filesById = new Map(Object.entries(plans).map(([id, plan]) => [id, plan.file]));
  for (const file of new Set(all.ids.map((id) => filesById.get(id)))) {
    const counts = shards.map(
      (shard) => shard.ids.filter((id) => filesById.get(id) === file).length,
    );
    assert.ok(Math.abs(counts[0] - counts[1]) <= 1);
  }
});

test("a shard pattern matches literal titles and keeps the caller's selection", () => {
  const selected = {
    first: { file: "provider-adoption.spec.ts", title: "Keep [saved] + accounts" },
    second: { file: "provider-adoption.spec.ts", title: "Do not select this" },
    other: { file: "another.spec.ts", title: "Keep [saved] + accounts elsewhere" },
  };
  const result = adoptionProofSelection(selected, "^Keep", "1/2");
  assert.deepEqual(result.ids, ["first"]);
  assert.equal(new RegExp(result.pattern).test(selected.first.title), true);
  assert.equal(new RegExp(result.pattern).test("Keep saved  accounts"), false);
  assert.equal(new RegExp(result.pattern).test(selected.other.title), false);
});

test("invalid and empty shards refuse instead of silently skipping proof", () => {
  assert.throws(() => adoptionProofSelection(plans, ".*", "3/3"), /must be 1\/2 or 2\/2/);
  assert.throws(() => adoptionProofSelection(plans, "no such case", "1/2"), /No provider adoption/);
});

test("unsharded Google recovery keeps the existing caller pattern and all declared cases", () => {
  const pattern = patternForGroup(
    "google-account-recovery:google-recovery-through-signed-cloud-operations",
  );
  const expected = Object.entries(plans)
    .filter(([, plan]) => new RegExp(pattern).test(plan.title))
    .map(([id]) => id)
    .sort();
  assert.ok(expected.length > 0);
  const result = adoptionProofSelection(plans, pattern);
  assert.equal(result.pattern, pattern);
  assert.deepEqual([...result.ids].sort(), expected);
});
