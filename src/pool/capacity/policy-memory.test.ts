import assert from "node:assert/strict";
import { test } from "node:test";
import { migratePolicies, policyChanges, type PolicyMemory } from "./policy-memory.ts";

const step = (memory: PolicyMemory, at: number, ...members: [string, string, string][]) =>
  policyChanges({
    memory,
    current: members.map(([group, account, revision]) => ({ group, account, revision })),
    at,
    keepFrom: 0,
  });

test("joining, leaving and returning at a known revision never restarts a cohort", () => {
  let memory = step({}, 1, ["pro-eq", "a", "policy-20"], ["pro-eq", "b", "pro"]).memory;
  const snapshots: [number, [string, string, string][]][] = [
    [
      2,
      [
        ["tokens", "a", "calibration-v1:900000"],
        ["pro-eq", "b", "pro"],
      ],
    ],
    [
      3,
      [
        ["pro-eq", "a", "policy-20"],
        ["pro-eq", "b", "pro"],
      ],
    ],
    [
      4,
      [
        ["tokens", "a", "calibration-v1:900000"],
        ["pro-eq", "b", "pro"],
      ],
    ],
    [
      5,
      [
        ["pro-eq", "c", "pro"],
        ["pro-eq", "b", "pro"],
      ],
    ],
  ];
  for (const [at, members] of snapshots) {
    const result = step(memory, at, ...members);
    assert.deepEqual([...result.changed], []);
    memory = result.memory;
  }
});

test("a member's new revision restarts its cohort, and returning to an old one restarts it again", () => {
  let memory = step({}, 1, ["pro-eq", "a", "x1"], ["pro-eq", "b", "pro"]).memory;
  let result = step(memory, 2, ["pro-eq", "a", "x2"], ["pro-eq", "b", "pro"]);
  assert.deepEqual([...result.changed], ["pro-eq"]);
  memory = result.memory;
  result = step(memory, 3, ["pro-eq", "a", "x1"], ["pro-eq", "b", "pro"]);
  assert.deepEqual([...result.changed], ["pro-eq"]);
});

test("revisions older than the retained demand are forgotten", () => {
  const memory = step({}, 1, ["pro-eq", "a", "x1"]).memory;
  const result = policyChanges({
    memory,
    current: [{ group: "pro-eq", account: "b", revision: "pro" }],
    at: 10,
    keepFrom: 5,
  });
  assert.deepEqual(result.memory, { "pro-eq": { b: { pro: 10 } } });
});

test("an index without the memory migrates with the old group rule once", () => {
  const current = [
    { group: "pro-eq", account: "a", revision: "policy-20" },
    { group: "tokens", account: "b", revision: "calibration-v1:1" },
  ];
  const migrated = migratePolicies({
    recorded: { "pro-eq": { revision: JSON.stringify(["policy-20"]) } },
    prior: [],
    current,
    at: 7,
  });
  assert.deepEqual([...migrated.changed], ["tokens"]);
  assert.deepEqual(migrated.memory, {
    "pro-eq": { a: { "policy-20": 7 } },
    tokens: { b: { "calibration-v1:1": 7 } },
  });
});
