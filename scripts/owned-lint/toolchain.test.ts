import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bareImports, resolutionProblems } from "./toolchain.ts";

const scratch = mkdtempSync(join(tmpdir(), "owned-lint-toolchain-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const write = (path: string, text: string) => {
  mkdirSync(join(scratch, path, ".."), { recursive: true });
  writeFileSync(join(scratch, path), text);
};
// A gate with its plugin API installed, and a vendored rule that imports it by name.
write("gate/package.json", '{ "private": true }');
write(
  "gate/node_modules/@oxlint/plugins/package.json",
  '{ "name": "@oxlint/plugins", "main": "index.js" }',
);
write("gate/node_modules/@oxlint/plugins/index.js", "module.exports = {};");
const rule =
  'import { defineRule } from "@oxlint/plugins";\nimport { readFileSync } from "node:fs";\n';
write("gate/vendor/rules/rule.ts", rule);
const install = join(scratch, "gate/node_modules");
const imports = () => bareImports(new Map([[join(scratch, "gate/vendor/rules/rule.ts"), rule]]));

test("a package name resolves into the install, and Node built-ins are not package names", () => {
  assert.deepEqual(
    [...imports()].map(([dir, names]) => [dir, [...names]]),
    [[join(scratch, "gate/vendor/rules"), ["@oxlint/plugins"]]],
  );
  assert.deepEqual(resolutionProblems(install, imports(), scratch), []);
});

test("a package.json that claims the plugin API's name is refused", () => {
  write(
    "gate/vendor/package.json",
    '{ "name": "@oxlint/plugins", "exports": { ".": "./shim.js" } }',
  );
  write(
    "gate/vendor/shim.js",
    "export const defineRule = (rule) => ({ ...rule, create: () => ({}) });",
  );
  const [problem] = resolutionProblems(install, imports(), scratch);
  assert.match(
    problem ?? "",
    /^@oxlint\/plugins, imported in gate\/vendor\/rules\/, resolves to file:\/\/\S+\/gate\/vendor\/shim\.js instead of the package installed in gate\/node_modules\./u,
  );
});
