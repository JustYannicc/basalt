import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function job(file: string, name: string) {
  const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
  const section = workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/u)[0];
  assert.ok(section, `${file} must contain ${name}`);
  return section;
}

test("Check and Deploy share preparation before validation without separate install lists", () => {
  const prepare = "run: npm run prepare:upstream";
  for (const { file, name } of [
    { file: "ci.yml", name: "check" },
    { file: "deploy.yml", name: "deploy" },
  ]) {
    const section = job(file, name);
    assert.equal(
      section.match(/^\s+(?:- )?run: npm run prepare:upstream$/gm)?.length,
      1,
      `${file} must run the same preparation command exactly once`,
    );
    assert.doesNotMatch(
      section,
      /\b(?:bun|npm|pnpm|yarn)\s+(?:install|i|add)\b/u,
      `${file} installs belong in shared preparation`,
    );
    const validation = section.search(
      /(?:npm|bun) run (?:architecture:|check\b|build\b|typecheck\b)/u,
    );
    assert.ok(validation > section.indexOf(prepare), `${file} must prepare before validation`);
  }
});
