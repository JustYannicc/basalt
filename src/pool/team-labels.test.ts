import assert from "node:assert/strict";
import { test } from "node:test";
import { labelPools, signedTeams } from "./team-labels.ts";

const teams = [
  { id: "org-work", name: "Work" },
  { id: "org-home", name: " Home " },
];

test("pools outside the person's teams drop out unless kept, and labels name the team", () => {
  const labelled = labelPools(
    [
      { id: "a", name: "", mine: true, organization: "org-work" },
      { id: "b", name: "GPUs", mine: false, organization: "org-home" },
      { id: "c", name: "", mine: true, organization: "org-deleted" },
      { id: "d", name: "Old", mine: true, organization: "org-gone" },
      { id: "e", name: "Legacy", mine: false },
    ],
    teams,
    "d",
  );
  assert.deepEqual(
    labelled.map(({ id, label }) => [id, label]),
    [
      ["a", "Your pool · Work"],
      ["b", "GPUs · Home"],
      ["d", "Old"],
      ["e", "Legacy"],
    ],
  );
});

test("without teams nothing is filtered, and matching labels are numbered", () => {
  const labelled = labelPools(
    [
      { id: "a", name: "Pool", mine: true, organization: "x" },
      { id: "b", name: "Pool", mine: true, organization: "y" },
    ],
    undefined,
  );
  assert.deepEqual(
    labelled.map(({ label }) => label),
    ["Pool (1)", "Pool (2)"],
  );
});

test("a malformed signed team list reads as unknown, not as no teams", () => {
  assert.deepEqual(signedTeams([{ id: "org", name: "Org" }]), [{ id: "org", name: "Org" }]);
  assert.deepEqual(signedTeams([]), []);
  for (const bad of [undefined, "org", [{ id: "", name: "x" }], [{ id: "org" }], [null]])
    assert.equal(signedTeams(bad), undefined);
});
