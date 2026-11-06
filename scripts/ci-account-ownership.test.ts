import assert from "node:assert/strict";
import { test } from "node:test";
import { readDeclarations, declaredMatrices, patternForGroup } from "./ci/declarations.ts";
import { selectPaths } from "./ci/affected.ts";

const owner = "account-acquisition:account-usage-rows-and-cells";
const removed = [
  [
    "account-observation-rows.spec.ts",
    "accountObservationRows",
    "host-managed-accounts:host-managed-visibility-and-existing-account-behavior",
  ],
  [
    "account-observation-row-polling.spec.ts",
    "accountObservationRowPolling",
    "host-managed-accounts-pool:retained-pool-accounts-and-usage-behavior",
  ],
  ["app-account-traffic.spec.ts", "appAccountTraffic", "declared:self-host"],
];

test("each duplicated account scenario retains one self-host owner and every affected input selects it", () => {
  const { files, groups } = readDeclarations();
  for (const [file, key, previous] of removed) {
    const entry = files[file!]!;
    assert.deepEqual(entry.runs[key!], [owner]);
    assert.equal(groups[owner]!.target, "self-host");
    assert.equal(groups[owner]!.mode, "managed");
    assert.equal(groups[owner]!.job, "account-usage");
    assert.ok(new RegExp(patternForGroup(owner)).test(entry.scenarios[key!]!.title));
    if (!groups[previous!]!.matrix)
      assert.ok(!new RegExp(patternForGroup(previous!)).test(entry.scenarios[key!]!.title));
    for (const input of [".upstream/e2e/tests/" + file, ...entry.inputs])
      assert.ok(selectPaths([input]).jobs.includes("account-usage"), input);
  }
  assert.ok(
    !declaredMatrices()["declared-self-host"]!.include.some(
      ({ file }) => file === "app-account-traffic.spec.ts",
    ),
  );
});
