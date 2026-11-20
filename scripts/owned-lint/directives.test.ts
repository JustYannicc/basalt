import assert from "node:assert/strict";
import { test } from "node:test";
import { directiveProblems } from "./directives.ts";

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

test("a rule list split by a character oxlint reads as a line end or a space is refused", () => {
  const off = (scope = "", tool = "oxlint") => `${tool}-disable${scope}`;
  // oxlint reads U+0085 as a space, so it sees no rule names and disables every rule.
  for (const text of [
    `// ${off()} \u0085 -- generated`,
    `// ${off("-next-line")} no-console\u0085anti-slop/no-reflect-get`,
    `  // ${off("-next-line", "eslint")}\r  return Reflect.get(target, "k");`,
    `// ${off("-next-line")}\u2028return Reflect.get(target, "k");`,
  ])
    assert.equal(directiveProblems("src/a.ts", text).length, 1, JSON.stringify(text));
  assert.deepEqual(
    directiveProblems("src/a.ts", `// ${off("-next-line")} no-console -- why\u0085 it stays`),
    [],
  );
});

test("a refusal names the line oxlint sees, with every JavaScript line end counted", () => {
  const off = `${"oxlint"}-disable-next-line`;
  const [problem] = directiveProblems("src/a.ts", `const a = 1;\rconst b = 2;\r\n// ${off}`);
  assert.match(problem ?? "", /^src\/a\.ts:3 /u);
});
