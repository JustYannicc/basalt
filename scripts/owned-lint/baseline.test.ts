import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Allowlist,
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

test("a test-double entry covers only the wire guard's tests, which replace the fetch it wraps", () => {
  const doubles = "landmines-testing/no-test-doubles";
  const reason = { count: 1, reason: "The guard under test wraps the global fetch." };
  const guard = "scripts/release/wire-guard-domain.test.ts";
  assert.deepEqual(compare([finding(doubles, guard)], {}, { [doubles]: { [guard]: reason } }), []);
  const elsewhere = "scripts/foo/bar.test.ts";
  const problems = compare(
    [finding(doubles, elsewhere)],
    {},
    { [doubles]: { [elsewhere]: reason } },
  );
  assert.match(problems.join("\n"), /outside the files this rule's entries may cover/u);
  assert.match(problems.join("\n"), /scripts\/foo\/bar\.test\.ts/u);
});

test("a raised-timeout entry covers one timeout in the bulk CLI's test file and nowhere else", () => {
  const masking = "landmines-testing/no-flake-masking";
  const file = "scripts/import-cpamp-bulk.test.ts";
  // landmines' own messages for the two kinds of finding this rule reports.
  const timeout = (path: string, line = 1) => ({
    rule: masking,
    file: path,
    line,
    message:
      "Do not raise a test's timeout. Wait on the event the test depends on, or move slow shared setup into a beforeAll hook.",
  });
  const retry = (path: string, line = 1) => ({
    rule: masking,
    file: path,
    line,
    message:
      "Do not retry tests. A test that passes on rerun is a flake: wait on the event it depends on and file the failure under the flaky-test tracker.",
  });
  const committed: Allowlist = JSON.parse(
    readFileSync(join(import.meta.dirname, "allowlist.json"), "utf8"),
  );
  const entry = committed[masking]?.[file];
  assert.deepEqual(entry, {
    count: 1,
    reason:
      "The real hold of more than 30 s is the proof for carry 0655; a shorter hold would prove a constant.",
  });
  const allowlist = { [masking]: { [file]: entry } };
  assert.deepEqual(compare([timeout(file, 412)], {}, allowlist), []);
  assert.match(allowlistAdditions(allowlist, {})[0]!, /allowlisted 0 -> 1: The real hold/u);

  const [second, ...rest] = compare([timeout(file, 412), timeout(file, 430)], {}, allowlist);
  assert.deepEqual(rest, []);
  assert.match(
    second!,
    /^scripts\/import-cpamp-bulk\.test\.ts: landmines-testing\/no-flake-masking found 2, allowlist allows 1 \("The real hold of more than 30 s is the proof for carry 0655[^"]*"\)[\s\S]*scripts\/owned-lint\/allowlist\.json[\s\S]*import-cpamp-bulk\.test\.ts:430/u,
  );
  // The reason covers a raised timeout only; a retry in the same file fails as it would anywhere.
  assert.deepEqual(compare([timeout(file, 412), retry(file, 420)], {}, allowlist), [
    `${file}:420 ${masking}: ${retry(file).message}`,
  ]);

  for (const near of [
    "scripts/pool-tests/import-cpamp-bulk.test.ts",
    "e2e/scripts/import-cpamp-bulk.test.ts",
    "scripts/import-cpamp-bulk.test.ts.orig",
    "scripts/import-cpamp-bulk.test.tsx",
    "scripts/import-cpamp-bulk-2.test.ts",
  ]) {
    const problems = compare([timeout(near)], {}, { [masking]: { [near]: entry } });
    assert.ok(
      problems.some((problem) => problem.includes(`${near} under ${masking} is outside`)),
      near,
    );
    assert.ok(
      problems.some((problem) => problem.startsWith(`${near}:1 ${masking}:`)),
      `${near}: the finding itself still fails`,
    );
  }
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

test("only a single `//` comment naming upstream rules may disable anything", () => {
  // Assembled so this file carries no directive of its own.
  const off = (tool: string, scope = "") => `${tool}-disable${scope}`;
  const text = [
    `// ${off("oxlint", "-next-line")}`,
    `/* ${off("eslint")} basalt/no-echo-stub */`,
    `// ${off("oxlint", "-next-line")} landmines-testing/no-fixed-sleep -- slow`,
    `// ${off("eslint", "-next-line")} typescript/no-explicit-any`,
    `/* ${off("oxlint", "-next-line")} typescript/no-explicit-any,`,
    "  basalt/no-discarded-child-output */",
    `/* ${off("oxlint")} unicorn/no-null */ /* ${off("oxlint")} */`,
    `<!-- ${off("oxlint", "-next-line")}`,
    `const quoted = "${off("oxlint")}";`,
  ].join("\n");
  assert.deepEqual(
    directiveProblems("src/a.ts", text).map((problem) => problem.split(" ")[0]),
    [
      "src/a.ts:1",
      "src/a.ts:2",
      "src/a.ts:3",
      "src/a.ts:5",
      "src/a.ts:7",
      "src/a.ts:7",
      "src/a.ts:8",
      "src/a.ts:9",
    ],
  );
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
    /pinned basalt and landmines plugins/u,
  );
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
});
