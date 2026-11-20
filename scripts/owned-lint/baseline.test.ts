import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowlistAdditions,
  basePolicy,
  compare,
  configProblems,
  count,
  nativeRules,
  optionChanges,
  ratchet,
} from "./baseline.ts";
import { directiveProblems } from "./directives.ts";

const finding = (rule: string, file: string, line = 1) => ({
  rule,
  file,
  line,
  message: "Use the real thing.",
});
const spread = "basalt/no-spread-into-provider-request";
const strict = "basalt/no-strict-provider-decode";

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

test("a baseline entry that is not a count fails instead of passing every finding", () => {
  // SAFETY: a hand-edited baseline.json can hold any JSON value; this is the one under test.
  const baseline = { [spread]: { "src/a.ts": "x" } } as never;
  assert.match(
    compare([finding(spread, "src/a.ts"), finding(spread, "src/a.ts", 2)], baseline, {})[0]!,
    /src\/a\.ts under basalt\/no-spread-into-provider-request is not a count of findings/u,
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

const state = (lintChanged = false, changed = (file: string) => file === "src/touched.ts") => ({
  allowlist: {},
  basePath: (file: string) =>
    ({ "src/new-name.ts": "src/old-name.ts", "src/moved.ts": "scripts/architecture/gen/moved.ts" })[
      file
    ] ?? (file.startsWith("src/new") ? undefined : file),
  changed,
  enteredScope: (file: string) => file === "src/moved.ts",
  lintChanged,
});
const enforced = new Set([spread]);

test("a committed baseline may only shrink against the base commit", () => {
  const base = { [spread]: { "src/a.ts": 1, "src/b.ts": 2 } };
  assert.deepEqual(
    ratchet({ [spread]: { "src/a.ts": 1, "src/b.ts": 1 } }, base, state(), enforced).problems,
    [],
  );
  assert.equal(
    ratchet({ [spread]: { "src/a.ts": 2, "src/b.ts": 2 } }, base, state(), enforced).problems
      .length,
    1,
  );
});

test("a new file carries no baseline, and a renamed one keeps its old count", () => {
  const base = { [spread]: { "src/old-name.ts": 2, "src/a.ts": 1 } };
  assert.deepEqual(
    ratchet({ [spread]: { "src/new-name.ts": 2 } }, base, state(), enforced).problems,
    [],
  );
  assert.match(
    ratchet({ [spread]: { "src/new-file.ts": 1 } }, base, state(), enforced).problems[0]!,
    /new files carry no baseline/u,
  );
});

test("while the rules change, only rises in untouched files are listed instead of failing", () => {
  const base = { [spread]: { "src/untouched.ts": 1, "src/touched.ts": 1 } };
  const current = {
    [spread]: { "src/untouched.ts": 3, "src/touched.ts": 2, "src/new-file.ts": 1 },
  };
  const result = ratchet(current, base, state(true), enforced);
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0]!, /src\/untouched\.ts/u);
  assert.equal(result.problems.length, 2);
});

test("code moved into the gated scope keeps its findings, listed for review", () => {
  const result = ratchet({ [spread]: { "src/moved.ts": 3 } }, {}, state(), enforced);
  assert.deepEqual(result.problems, []);
  assert.match(
    result.notices[0]!,
    /moved into the gated scope from scripts\/architecture\/gen\/moved\.ts/u,
  );
});

test("a rule the base did not enforce brings its own baseline", () => {
  assert.deepEqual(
    ratchet({ "basalt/new-rule": { "src/a.ts": 4 } }, {}, state(), enforced).problems,
    [],
  );
});

const plugins = [
  { name: "basalt", specifier: "./plugin/basalt.mjs" },
  { name: "landmines-testing", specifier: "@interfere/landmines/testing" },
  { name: "landmines-structure", specifier: "@interfere/landmines/structure" },
  { name: "anti-slop", specifier: "./vendor/anti-slop/index.ts" },
  { name: "anti-slop-effect", specifier: "./vendor/anti-slop/effect/index.ts" },
];

test("the configuration loads the pinned plugins, keeps what the base enforced, and nothing else", () => {
  const base = {
    rules: {
      [spread]: "error",
      [strict]: ["error", { comparators: ["x"] }],
      "basalt/other": "off",
    },
  };
  assert.deepEqual(
    configProblems(
      { jsPlugins: plugins, rules: { [spread]: "error", [strict]: ["error", {}] } },
      base,
    ),
    [],
  );
  assert.equal(configProblems({ jsPlugins: plugins, rules: { [spread]: "off" } }, base).length, 2);
  assert.match(
    configProblems({ jsPlugins: plugins, rules: {}, overrides: [] }, undefined)[0]!,
    /takes no "overrides"/u,
  );
  assert.match(
    configProblems({ jsPlugins: plugins, rules: {}, extends: ["./shared.json"] }, undefined)[0]!,
    /takes no "extends"/u,
  );
  const swapped = plugins.map((plugin) => ({ ...plugin, specifier: "./empty.mjs" }));
  assert.match(
    configProblems({ jsPlugins: swapped, rules: {} }, undefined)[0]!,
    /pinned plugins: basalt, landmines-testing, landmines-structure, anti-slop, anti-slop-effect\./u,
  );
  assert.match(
    configProblems({ jsPlugins: plugins.slice(0, 4), rules: {} }, undefined)[0]!,
    /must load exactly the pinned plugins/u,
  );
});

test("a built-in rule is written once, with its plugin listed, so no other spelling can switch it off", () => {
  const rules = { "oxc/no-accumulating-spread": "error", "basalt/no-echo-stub": "error" };
  assert.deepEqual(configProblems({ jsPlugins: plugins, plugins: ["oxc"], rules }, undefined), []);
  for (const config of [
    { jsPlugins: plugins, plugins: [], rules },
    { jsPlugins: plugins, rules },
    { jsPlugins: plugins, plugins: ["oxc"], rules: { "no-accumulating-spread": "error" } },
    { jsPlugins: plugins, plugins: ["oxc"], rules: { ...rules, "no-accumulating-spread": "off" } },
    {
      jsPlugins: plugins,
      plugins: ["oxc"],
      rules: { ...rules, "eslint/no-accumulating-spread": "off" },
    },
    // oxlint strips the prefix, so this switches the anti-slop rule off.
    {
      jsPlugins: plugins,
      plugins: ["oxc"],
      rules: { ...rules, "eslint-plugin-anti-slop/no-reflect-get": "off" },
    },
    { jsPlugins: plugins, plugins: [], rules: { "oxc/no-accumulating-spread": "off" } },
  ])
    assert.match(
      configProblems(config, undefined).join("\n"),
      /names no pinned JS plugin, so write it as a built-in rule, once, as <plugin>\/<rule> with its plugin listed in "plugins"/u,
      JSON.stringify(config),
    );
  for (const off of ["off", "allow", 0])
    assert.deepEqual(
      configProblems(
        { jsPlugins: plugins, plugins: ["oxc"], rules: { "oxc/no-accumulating-spread": off } },
        undefined,
      ),
      [],
    );
  assert.deepEqual(
    configProblems(
      { jsPlugins: plugins, plugins: [], rules: { "eslint/no-debugger": 2 } },
      undefined,
    ),
    [],
  );
});

test("an anti-slop or built-in owned rule takes no disable comment either", () => {
  const off = (scope: string, tool = "oxlint") => `${tool}-disable${scope}`;
  const native = nativeRules({
    jsPlugins: plugins,
    rules: {
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-reflect-get": "error",
      "eslint/no-debugger": "off",
    },
  });
  assert.deepEqual([...native], ["no-accumulating-spread"]);
  // oxlint applies a disable comment to a built-in rule under any prefix.
  const text = [
    `// ${off("-next-line")} anti-slop/no-reflect-get`,
    `// ${off("-next-line")} anti-slop-effect/prefer-effect-match`,
    `// ${off("-next-line")} oxc/no-accumulating-spread`,
    `// ${off("-next-line")} no-accumulating-spread`,
    `// ${off("-next-line")} eslint/no-accumulating-spread`,
    `// ${off("")} typescript/no-accumulating-spread`,
    `// ${off("-next-line")} typescript/no-explicit-any`,
  ].join("\n");
  assert.deepEqual(
    directiveProblems("src/a.ts", text, native).map((problem) => problem.split(" ")[0]),
    ["src/a.ts:1", "src/a.ts:2", "src/a.ts:3", "src/a.ts:4", "src/a.ts:5", "src/a.ts:6"],
  );
});

test("changed options of an enforced rule are listed, apart from landmines' own counts", () => {
  const fixed = "landmines-testing/no-fixed-sleep";
  const typeofRule = "anti-slop/no-runtime-typeof";
  const base = {
    rules: {
      [typeofRule]: ["error", { allowInTypeGuards: true }],
      [fixed]: ["error", { allow: { "src/a.test.ts": 2 } }],
      "anti-slop/require-readable-spacing": "off",
    },
  };
  const current = {
    rules: {
      [typeofRule]: ["error", { allowInTypeGuards: true, allowExistenceChecks: true }],
      [fixed]: ["error", { allow: { "src/a.test.ts": 1 } }],
      "anti-slop/require-readable-spacing": ["error", { anything: true }],
    },
  };
  assert.deepEqual(optionChanges(current, base), [
    `${typeofRule} options [{"allowInTypeGuards":true}] -> [{"allowInTypeGuards":true,"allowExistenceChecks":true}]`,
  ]);
  assert.deepEqual(optionChanges(base, base), []);
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

test("no allowlist reason covers a decode the rule recognised as a provider response", () => {
  const response = {
    ...finding(strict, "src/a.ts"),
    message: "Strict decode of a provider response: ...",
  };
  const allowlist = { [strict]: { "src/a.ts": { count: 1, reason: "Decodes our own data." } } };
  assert.ok(
    compare([response], {}, allowlist).some((problem) =>
      /found 1, baseline allows 0/u.test(problem),
    ),
  );
});

test("against the base, policy combines the config, allowlist and both ratchets", () => {
  const current = {
    config: { jsPlugins: plugins, rules: { [spread]: "error" } },
    baseline: { [spread]: { "src/a.ts": 2 } },
    allowlist: {},
  };
  const base = {
    ...state(),
    config: { rules: { [spread]: "error", "basalt/later": "off" } },
    baseline: { [spread]: { "src/a.ts": 1 } },
  };
  assert.equal(basePolicy(current, base).problems.length, 1);
  const enabled = {
    ...current,
    baseline: { [spread]: { "src/a.ts": 1 }, "basalt/later": { "src/b.ts": 3 } },
  };
  assert.deepEqual(basePolicy(enabled, base).problems, []);
  const loosened = {
    ...enabled,
    config: { jsPlugins: plugins, rules: { [spread]: ["error", { ignore: ["*"] }] } },
  };
  assert.match(
    basePolicy(loosened, base).notices.join("\n"),
    /Rule options changed, review what they now find: basalt\/no-spread-into-provider-request options \[\] -> \[\{"ignore":\["\*"\]\}\]/u,
  );
});
