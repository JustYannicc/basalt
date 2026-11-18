import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { test } from "node:test";
import { budgetErrors, testFile, tombstoned, type Budget } from "./budget.ts";
import { git, measured, root } from "./test/history.ts";

const budget: Budget = JSON.parse(readFileSync(new URL("./budget.json", import.meta.url), "utf8"));
const none = { droppedPaths: [], addedToTombstones: [], pullRequest: null };
// Net source lines a merge into main added to the release path.
const growth = (merge: string) =>
  git(["diff", "--numstat", "--no-renames", `${merge}^1`, merge])
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      ([, , file]) =>
        file && measured.some((pattern) => matchesGlob(file, pattern)) && !testFile.test(file),
    )
    .reduce((sum, [added, removed]) => sum + (Number(added) || 0) - (Number(removed) || 0), 0);

test("stops the 7 Nov batch that brought the release barrier until it has a reuse decision and approval", () => {
  // f4c5b58f4 (#611, batch b21) merged the first barrier commit, 0f3f01cc9.
  const added = growth("f4c5b58f4");
  assert.equal(added, 2402);
  const before: Budget = { lines: 10_000, testLines: 0, tombstones: [] };
  const grown = { lines: before.lines + added, testLines: 0 };
  assert.match(
    budgetErrors({ ...none, count: grown, budget: before, base: before })[0]!,
    /source grew to 12402 lines against a budget of 10000/,
  );
  // Raising the number alone is not enough: it needs the decision and the label.
  const raised = { ...before, lines: grown.lines };
  const pullRequest = { body: "Validate every Worker version before activation.", labels: [] };
  assert.equal(
    budgetErrors({ ...none, count: grown, budget: raised, base: before, pullRequest }).length,
    2,
  );
  const approved = {
    body: "## Reuse decision\nAlchemy uploads versions without activating them (https://alchemy.run/cloudflare/compute/workers), but not across 20 Workers at once.\n",
    labels: ["release-budget-approved"],
  };
  assert.deepEqual(
    budgetErrors({ ...none, count: grown, budget: raised, base: before, pullRequest: approved }),
    [],
  );
});

test("would have put each of the 67 merges that grew the release path in front of that gate", () => {
  const merges = git(["rev-list", "--first-parent", "f4c5b58f4^1..374ba512d^1"])
    .split("\n")
    .filter(Boolean);
  const grew = merges.map(growth).filter((lines) => lines > 0);
  // 67 of the 113 merges from the barrier to 18 Nov grew it, by 38,583 source lines in all.
  assert.deepEqual(
    [grew.length, merges.length, grew.reduce((a, b) => a + b, 0)],
    [67, 113, 38_583],
  );
});

test("refuses new lines in the removed release layer", () => {
  // 374ba512 (#1364), the last merge of 18 Nov, added another settlement disposition to it.
  const added = git(["diff", "--numstat", "--no-renames", "374ba512d^1", "374ba512d"])
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([lines, , file]) => file && Number(lines) > 0 && tombstoned(file, budget))
    .map(([lines, , file]) => ({ file: file!, added: Number(lines) }));
  assert.ok(added.length > 0);
  const count = { lines: budget.lines, testLines: budget.testLines };
  const errors = budgetErrors({ ...none, count, budget, base: budget, addedToTombstones: added });
  assert.equal(errors.length, added.length);
  assert.ok(errors.every((error) => /removed path/.test(error)));
});

test("a shrinking release path must lower the budget, and needs no approval", () => {
  const was: Budget = { lines: 1000, testLines: 500, tombstones: [] };
  const count = { lines: 900, testLines: 500 };
  assert.match(
    budgetErrors({ ...none, count, budget: was, base: was })[0]!,
    /lower "lines".+ to 900/,
  );
  const lowered = { ...was, lines: 900 };
  assert.deepEqual(budgetErrors({ ...none, count, budget: lowered, base: was }), []);
});

test("test machinery counts too", () => {
  const was: Budget = { lines: 1000, testLines: 500, tombstones: [] };
  const errors = budgetErrors({
    ...none,
    count: { lines: 1000, testLines: 900 },
    budget: was,
    base: was,
  });
  assert.match(errors[0]!, /test grew to 900 lines/);
});

test("reopening a tombstone or dropping a path from the release path needs the same approval", () => {
  const was: Budget = { lines: 900, testLines: 0, tombstones: ["scripts/release-barrier/**"] };
  const reopened = { ...was, tombstones: [] };
  const count = { lines: 900, testLines: 0 };
  const pullRequest = { body: "", labels: [] };
  assert.equal(
    budgetErrors({ ...none, count, budget: reopened, base: was, pullRequest }).length,
    2,
  );
  const dropped = budgetErrors({
    ...none,
    count,
    budget: was,
    base: was,
    droppedPaths: ["scripts/release/**"],
    pullRequest,
  });
  assert.match(dropped[1]!, /drops scripts\/release\/\*\* from the release path/);
});

test("budget.json matches the tree", () => {
  // Outside a pull request run, so the label lookup that needs a token does not start.
  const env = { ...process.env };
  delete env.GITHUB_EVENT_PATH;
  const counted = execFileSync("node", ["scripts/guardrails/budget.ts"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.match(counted, /as budgeted/);
});
