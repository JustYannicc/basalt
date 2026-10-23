import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { glossaryValues, languageErrors } from "./language.ts";
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture(file: string, source: string) {
  const root = mkdtempSync(join(tmpdir(), "architecture-language-"));
  temporary.push(root);
  mkdirSync(join(root, "architecture"));
  writeFileSync(join(root, "architecture", file), source);
  return root;
}
test("product names fail with the own-name replacement", () => {
  const root = fixture("model.c4", 'model { module proxy "CLIProxyAPI" }');
  expect(languageErrors(root)[0]).toContain("use 'model gateway' from CONTEXT.md instead of CLIProxyAPI");
});
test("underlying adapter technology may name its product", () => {
  const root = fixture("model.c4", 'model { adapter runtime "Runtime adapter" { technology "Cloudflare Workers" } }');
  expect(languageErrors(root)).toEqual([]);
});
test("prose has no technology-string exemption", () => {
  const root = fixture("README.md", 'technology "Executor"');
  expect(languageErrors(root)[0]).toContain("tools gateway");
});
test("glossary tables define the vocabulary and missing sections fail", () => {
  const glossary = "## Element kinds\n\n| `module` | Deep module |\n";
  expect([...glossaryValues(glossary, "Element kinds")]).toEqual(["module"]);
  expect(() => glossaryValues(glossary, "Tags")).toThrow("Missing glossary section");
});
