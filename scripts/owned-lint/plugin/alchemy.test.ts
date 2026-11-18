import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { lint } from "../check.ts";
import { commandAutoApprovesAlchemy } from "./alchemy.mjs";

const repository = join(import.meta.dirname, "../../..");
const cases: Record<string, string> = {
  // production: scripts/preview/lifecycle.ts:149 at 1d75a5f1, every preview deploy and destroy.
  "scripts/preview/lifecycle.ts": `
export const args = (action: string, config: string, stage: string) => [
  "exec",
  "alchemy",
  action,
  config,
  "--stage",
  stage,
  "--yes", // expect: basalt/no-alchemy-auto-approve
  "--no-input",
];
`,
  "scripts/stage.ts": `
import { execSync } from "node:child_process";
execSync("bunx alchemy destroy --stage scratch -y"); // expect: basalt/no-alchemy-auto-approve
execSync("bunx alchemy deploy --dry-run --stage scratch");
export const unrelated = ["deploy", "--yes"];
`,
};

const root = mkdtempSync(join(tmpdir(), "owned-lint-alchemy-"));
after(() => rmSync(root, { recursive: true, force: true }));
for (const [file, source] of Object.entries(cases)) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), source.trimStart());
}
const findings = lint(Object.keys(cases), undefined, root).filter(
  ({ rule }) => rule === "basalt/no-alchemy-auto-approve",
);

for (const [file, source] of Object.entries(cases))
  test(`no-alchemy-auto-approve on ${file}`, () => {
    const expected = source
      .trimStart()
      .split("\n")
      .flatMap((text, index) => (text.includes("// expect:") ? [index + 1] : []));
    assert.deepEqual(
      findings.filter((finding) => finding.file === file).map(({ line }) => line),
      expected,
    );
  });

// Workflow steps and package scripts run commands Oxlint never reads.
test("no workflow step or package script passes --yes to Alchemy", () => {
  const workflows = join(repository, ".github/workflows");
  const offenders: string[] = [];
  for (const name of readdirSync(workflows).filter((file) => /\.ya?ml$/u.test(file)))
    readFileSync(join(workflows, name), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (commandAutoApprovesAlchemy(line))
          offenders.push(`.github/workflows/${name}:${index + 1}`);
      });
  const scripts = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).scripts ?? {};
  for (const [name, command] of Object.entries<string>(scripts))
    if (commandAutoApprovesAlchemy(command)) offenders.push(`package.json scripts.${name}`);
  assert.deepEqual(offenders, []);
});

test("recognises the command shapes Alchemy's CLI accepts", () => {
  assert.equal(commandAutoApprovesAlchemy("bun exec alchemy deploy alchemy.run.ts --yes"), true);
  assert.equal(commandAutoApprovesAlchemy("run: bunx alchemy destroy --stage pr-1 -y"), true);
  assert.equal(commandAutoApprovesAlchemy("bunx alchemy deploy --dry-run"), false);
  assert.equal(commandAutoApprovesAlchemy("npx wrangler deploy --yes"), false);
});
