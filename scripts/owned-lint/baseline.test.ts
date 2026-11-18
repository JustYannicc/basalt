import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowlistAdditions,
  basePolicy,
  compare,
  configProblems,
  count,
  directiveProblems,
  ratchet,
} from "./baseline.ts";

const finding = (rule: string, file: string, line = 1) => ({
  rule,
  file,
  line,
  message: "Use the real thing.",
});
const spread = "basalt/no-spread-into-provider-request";
const strict = "basalt/no-strict-provider-decode";
const rules = new Set([spread]);

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

test("an allowlist entry covers exactly its count, for the rules that offer one", () => {
  const allowlist = { [strict]: { "src/a.ts": { count: 1, reason: "Our own receipt." } } };
  assert.deepEqual(compare([finding(strict, "src/a.ts")], {}, allowlist), []);
  assert.match(
    compare([finding(strict, "src/a.ts"), finding(strict, "src/a.ts", 7)], {}, allowlist)[0]!,
    /found 2, allowlist allows 1 \("Our own receipt\."\)[\s\S]*src\/a\.ts:7/u,
  );
  assert.match(compare([], {}, allowlist)[0]!, /allowlist entry but no findings/u);
  const misuse = { [spread]: { "src/a.ts": { count: 1, reason: "Convenient." } } };
  assert.match(
    compare([finding(spread, "src/a.ts")], {}, misuse)[0]!,
    /takes no allowlist entries/u,
  );
});

test("landmines keeps its own counts and a parse failure is never baselined", () => {
  const problems = compare(
    [
      finding("landmines-testing/no-flake-masking", "src/a.test.ts", 3),
      finding("oxlint/parse", "src/b.ts", 2),
    ],
    {},
    {},
  );
  assert.match(problems[0]!, /^src\/a\.test\.ts:3 landmines-testing\/no-flake-masking/u);
  assert.match(problems[1]!, /^src\/b\.ts:2 oxlint\/parse/u);
});

test("disable comments for owned rules, or for every rule, are refused", () => {
  // Assembled so this file carries no directive of its own.
  const off = (tool: string, scope = "") => `${tool}-disable${scope}`;
  const text = [
    `// ${off("oxlint", "-next-line")}`,
    "a();",
    `/* ${off("eslint")} basalt/no-echo-stub */`,
    `// ${off("oxlint", "-next-line")} landmines-testing/no-fixed-sleep -- slow`,
    `// ${off("eslint", "-next-line")} typescript/no-explicit-any`,
    `const quoted = "${off("oxlint")}";`,
  ].join("\n");
  const problems = directiveProblems("src/a.ts", text);
  assert.deepEqual(
    problems.map((problem) => problem.split(" ")[0]),
    ["src/a.ts:1", "src/a.ts:3", "src/a.ts:4"],
  );
  assert.match(problems[0]!, /disables every rule/u);
});

test("a committed baseline may only shrink against the base commit", () => {
  const base = { [spread]: { "src/a.ts": 1, "src/b.ts": 2 } };
  const existed = () => true;
  assert.deepEqual(
    ratchet({ [spread]: { "src/a.ts": 1, "src/b.ts": 1 } }, base, existed, rules),
    [],
  );
  assert.equal(
    ratchet({ [spread]: { "src/a.ts": 2, "src/b.ts": 2 } }, base, existed, rules).length,
    2,
  );
});

test("a renamed file may carry its findings, but the rule's total may not rise", () => {
  const base = { [spread]: { "src/old.ts": 2 } };
  const existed = (file: string) => file === "src/old.ts";
  assert.deepEqual(ratchet({ [spread]: { "src/new.ts": 2 } }, base, existed, rules), []);
  assert.match(
    ratchet({ [spread]: { "src/new.ts": 3 } }, base, existed, rules)[0]!,
    /total rose from 2 to 3/u,
  );
});

test("a rule the base did not configure brings its own baseline", () => {
  assert.deepEqual(
    ratchet({ "basalt/new-rule": { "src/a.ts": 4 } }, {}, () => true, rules),
    [],
  );
});

test("an enforced rule may not be switched off or removed", () => {
  const base = {
    rules: {
      [spread]: "error",
      [strict]: ["error", { comparators: ["x"] }],
      "basalt/other": "off",
    },
  };
  assert.deepEqual(
    configProblems({ rules: { [spread]: "error", [strict]: ["error", {}] } }, base),
    [],
  );
  assert.equal(configProblems({ rules: { [spread]: "off" } }, base).length, 2);
});

test("new or raised allowlist entries are listed for review with their reasons", () => {
  const base = { [strict]: { "src/a.ts": { count: 1, reason: "Own data." } } };
  const current = {
    [strict]: {
      "src/a.ts": { count: 2, reason: "Own data." },
      "src/b.ts": { count: 1, reason: "Own journal." },
    },
  };
  assert.deepEqual(allowlistAdditions(current, base), [
    `src/a.ts: ${strict} allowlisted 1 -> 2: Own data.`,
    `src/b.ts: ${strict} allowlisted 0 -> 1: Own journal.`,
  ]);
});

test("counts are grouped by rule and file, in a stable order", () => {
  assert.equal(
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

test("an allowlist entry without a count and a reason exempts nothing", () => {
  for (const entry of [{ count: 0, reason: "Own data." }, { count: 1, reason: " " }, "Own data."]) {
    const allowlist = { [strict]: { "src/a.ts": entry } } as never;
    const problems = compare([finding(strict, "src/a.ts")], {}, allowlist);
    assert.ok(
      problems.some((problem) => /needs \{ "count"/u.test(problem)),
      JSON.stringify(entry),
    );
    assert.ok(
      problems.some((problem) => /found 1, baseline allows 0/u.test(problem)),
      JSON.stringify(entry),
    );
  }
});

test("the configuration takes no per-file overrides", () => {
  assert.match(configProblems({ rules: {}, overrides: [] }, undefined)[0]!, /takes no overrides/u);
});

const state = {
  config: { rules: { [spread]: "error" } },
  baseline: { [spread]: { "src/a.ts": 2 } },
  allowlist: {},
};
const base = {
  config: { rules: { [spread]: "error", "basalt/later": "off" } },
  baseline: { [spread]: { "src/a.ts": 1 } },
  allowlist: {},
  existed: () => true,
  lintChanged: false,
};

test("against the base, a rise fails, or is listed for review while the rules change", () => {
  assert.equal(basePolicy(state, base).problems.length, 2);
  const changing = basePolicy(state, { ...base, lintChanged: true });
  assert.deepEqual(changing.problems, []);
  assert.equal(
    changing.notices.filter((line) => line.startsWith("Rules or pins changed")).length,
    2,
  );
});

test("a rule that was off at the base can be enabled with its own baseline", () => {
  const enabled = { ...state, baseline: { ...base.baseline, "basalt/later": { "src/b.ts": 3 } } };
  assert.deepEqual(basePolicy(enabled, base).problems, []);
});
