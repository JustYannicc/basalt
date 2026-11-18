import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { test } from "node:test";
import { budgetErrors, tombstoned, type Budget } from "./budget.ts";

const root = new URL("../..", import.meta.url).pathname;
const budget: Budget = JSON.parse(readFileSync(new URL("./budget.json", import.meta.url), "utf8"));
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 }).trim();
const needsHistory = {
  skip: ["f4c5b58f4", "374ba512d"].every(
    (sha) => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root }).status === 0,
  )
    ? false
    : "needs the full repository history",
};
// The release path the history was measured with (release-path.test.ts), source files only.
const measured = [
  "alchemy.run.ts",
  "release-declarations.json",
  "patches/*alchemy*",
  "scripts/release-barrier/**",
  "scripts/release-phases/**",
  "scripts/release-merge/**",
  "scripts/deploy-safety/**",
  "scripts/deploy-main/**",
  "scripts/deploy.ts",
  ".github/workflows/deploy.yml",
  ".github/workflows/release-main.yml",
  ".github/workflows/release-manual.yml",
  ".github/workflows/release-rollback.yml",
  ".github/workflows/pool-runtime-provision.yml",
];
const testFile = /(?:^|\/)(?:test|tests|fixtures|[\w-]+-tests)\/|\.test\.[cm]?[jt]s$/u;
// Net source lines a merge into main added to the release path.
const growth = (merge: string) =>
  git(["diff", "--numstat", "--no-renames", `${merge}^1`, merge])
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      ([, , file]) => file && measured.some((p) => matchesGlob(file, p)) && !testFile.test(file),
    )
    .reduce((sum, [added, removed]) => sum + (Number(added) || 0) - (Number(removed) || 0), 0);

test(
  "stops the 7 Nov batch that brought the release barrier until it carries a reuse decision and approval",
  needsHistory,
  () => {
    // f4c5b58f4 (#611, batch b21) merged the first barrier commit, 0f3f01cc9.
    const added = growth("f4c5b58f4");
    assert.ok(added >= 2_400, String(added));
    const before: Budget = { lines: 10_000, tombstones: [] };
    const errors = budgetErrors({
      lines: before.lines + added,
      budget: before,
      base: before,
      addedToTombstones: [],
      pullRequest: { body: "Validate every Worker version before activation.", labels: [] },
    });
    assert.match(errors[0]!, /grew to \d+ lines against a budget of 10000/);
    // Raising the number alone is not enough: it needs the decision and the label.
    const raised = { ...before, lines: before.lines + added };
    const unapproved = budgetErrors({
      lines: raised.lines,
      budget: raised,
      base: before,
      addedToTombstones: [],
      pullRequest: { body: "", labels: [] },
    });
    assert.equal(unapproved.length, 2);
    const approved = budgetErrors({
      lines: raised.lines,
      budget: raised,
      base: before,
      addedToTombstones: [],
      pullRequest: {
        body: "## Reuse decision\nAlchemy uploads versions without activating them: https://alchemy.run/cloudflare/compute/workers but not across 20 Workers at once.\n",
        labels: ["release-budget-approved"],
      },
    });
    assert.deepEqual(approved, []);
  },
);

test(
  "would have put each of the 67 merges that grew the release path in front of that gate",
  needsHistory,
  () => {
    const merges = git([
      "rev-list",
      "--first-parent",
      "--since=2026-11-06",
      "f4c5b58f4^1..374ba512d^1",
    ])
      .split("\n")
      .filter(Boolean);
    const grew = merges.map(growth).filter((lines) => lines > 0);
    // 67 of the 113 merges from the barrier to 18 Nov grew it, by 38,583 source lines in all.
    assert.deepEqual(
      [grew.length, merges.length, grew.reduce((a, b) => a + b, 0)],
      [67, 113, 38_583],
    );
  },
);

test("refuses new lines in the removed release layer", needsHistory, () => {
  // 374ba512 (#1364), the last merge of 18 Nov, added another settlement disposition to it.
  const added = git(["diff", "--numstat", "--no-renames", "374ba512d^1", "374ba512d"])
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([lines, , file]) => file && Number(lines) > 0 && tombstoned(file, budget))
    .map(([lines, , file]) => ({ file: file!, added: Number(lines) }));
  assert.ok(added.length > 0);
  const errors = budgetErrors({
    lines: budget.lines,
    budget,
    base: budget,
    addedToTombstones: added,
    pullRequest: { body: "", labels: [] },
  });
  assert.ok(errors.every((error) => /removed path/.test(error)) && errors.length === added.length);
});

test("a shrinking release path must lower the budget, and needs no approval", () => {
  const shrunk = budgetErrors({
    lines: 900,
    budget: { lines: 1000, tombstones: [] },
    base: { lines: 1000, tombstones: [] },
    addedToTombstones: [],
    pullRequest: null,
  });
  assert.match(shrunk[0]!, /lower "lines" in budget.json to 900/);
  const lowered = { lines: 900, tombstones: [] };
  assert.deepEqual(
    budgetErrors({
      lines: 900,
      budget: lowered,
      base: { lines: 1000, tombstones: [] },
      addedToTombstones: [],
      pullRequest: null,
    }),
    [],
  );
});

test("reopening a tombstone needs the same approval as growth", () => {
  const errors = budgetErrors({
    lines: 900,
    budget: { lines: 900, tombstones: [] },
    base: { lines: 900, tombstones: ["scripts/release-barrier/**"] },
    addedToTombstones: [],
    pullRequest: { body: "", labels: [] },
  });
  assert.equal(errors.length, 2);
  assert.match(errors[1]!, /reopens scripts\/release-barrier/);
});

test("budget.json matches the tree", () => {
  const counted = execFileSync("node", ["scripts/guardrails/budget.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(
    counted,
    new RegExp(`Release tooling: ${budget.lines} of ${budget.lines} budgeted lines`),
  );
});
