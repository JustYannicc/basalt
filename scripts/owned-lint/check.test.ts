import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, count, ratchet } from "./check.ts";

const finding = (rule: string, file: string, line = 1) => ({
  rule,
  file,
  line,
  message: "Use the real thing.",
});
const spread = "basalt/no-spread-into-provider-request";

test("a finding the baseline does not hold fails with its location and advice", () => {
  const problems = compare(
    [finding(spread, "src/a.ts", 4), finding(spread, "src/a.ts", 9)],
    { [spread]: { "src/a.ts": 1 } },
    {},
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /found 2, baseline allows 1/u);
  assert.match(problems[0]!, /src\/a\.ts:4 Use the real thing\./u);
  assert.match(problems[0]!, /src\/a\.ts:9 Use the real thing\./u);
});

test("the recorded count passes, and a lower count must be written down", () => {
  assert.deepEqual(compare([finding(spread, "src/a.ts")], { [spread]: { "src/a.ts": 1 } }, {}), []);
  const [problem] = compare([], { [spread]: { "src/a.ts": 1 } }, {});
  assert.match(
    problem!,
    /down to 0 from 1\. Lower the baseline: npm run lint:owned -- --write-baseline/u,
  );
});

test("an allowlisted file is exempt, and an entry with nothing left to allow fails", () => {
  const allowlist = { [spread]: { "src/a.ts": "Our own data." } };
  assert.deepEqual(compare([finding(spread, "src/a.ts")], {}, allowlist), []);
  assert.match(compare([], {}, allowlist)[0]!, /allowlist entry but no findings/u);
});

test("landmines keeps its own counts, so any finding of those rules fails", () => {
  const [problem] = compare(
    [finding("landmines-testing/no-flake-masking", "src/a.test.ts", 3)],
    {},
    {},
  );
  assert.match(problem!, /^src\/a\.test\.ts:3 landmines-testing\/no-flake-masking/u);
});

test("a committed baseline may only shrink against the base commit", () => {
  const base = { [spread]: { "src/a.ts": 1, "src/b.ts": 2 } };
  const existed = () => true;
  assert.deepEqual(ratchet({ [spread]: { "src/a.ts": 1, "src/b.ts": 1 } }, base, existed), []);
  assert.equal(ratchet({ [spread]: { "src/a.ts": 2, "src/b.ts": 2 } }, base, existed).length, 2);
});

test("a renamed file may carry its findings, but the rule's total may not rise", () => {
  const base = { [spread]: { "src/old.ts": 2 } };
  const existed = (file: string) => file === "src/old.ts";
  assert.deepEqual(ratchet({ [spread]: { "src/new.ts": 2 } }, base, existed), []);
  assert.match(
    ratchet({ [spread]: { "src/new.ts": 3 } }, base, existed)[0]!,
    /total rose from 2 to 3/u,
  );
});

test("counts are grouped by rule and file, in a stable order", () => {
  assert.deepEqual(
    JSON.stringify(
      count([
        finding("b/r", "z.ts"),
        finding("a/r", "y.ts"),
        finding("b/r", "a.ts"),
        finding("b/r", "z.ts"),
      ]),
    ),
    JSON.stringify({ "a/r": { "y.ts": 1 }, "b/r": { "a.ts": 1, "z.ts": 2 } }),
  );
});
