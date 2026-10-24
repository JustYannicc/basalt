import assert from "node:assert/strict";
import { test } from "node:test";
import { manualCandidateOutputLines, parseExpectedManualIdentity, parseManualPullRequestNumber } from "./manual-candidate.ts";

test("manual candidate accepts only a positive safe integer PR number", () => {
  assert.equal(parseManualPullRequestNumber("1419"), 1419);
  for (const value of [undefined, "0", "01", "1.5", "1e3", "1\nhead=x", "9".repeat(30)])
    assert.throws(() => parseManualPullRequestNumber(value));
});

test("manual candidate output contains only validated one-line identity fields", () => {
  assert.equal(
    manualCandidateOutputLines({ pullRequest: 1419, head: "a".repeat(40), base: "b".repeat(40), source: "home" }),
    `pullRequest=1419\nhead=${"a".repeat(40)}\nbase=${"b".repeat(40)}\nsource=home\n`,
  );
  assert.throws(() => manualCandidateOutputLines({ pullRequest: 1419, head: "a\nsource=tools", base: "b".repeat(40), source: "home" }));
});

test("manual protected-stage identity requires both exact expected SHAs", () => {
  assert.deepEqual(parseExpectedManualIdentity("a".repeat(40), "b".repeat(40)), { head: "a".repeat(40), base: "b".repeat(40) });
  assert.deepEqual(parseExpectedManualIdentity(undefined, undefined), {});
  assert.throws(() => parseExpectedManualIdentity("a".repeat(40), undefined), /together/);
  assert.throws(() => parseExpectedManualIdentity("short", "b".repeat(40)), /full commit SHAs/);
});
