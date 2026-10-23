import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { stackFingerprint } from "./fingerprint.ts";
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "architecture-fingerprint-"));
  temporary.push(root);
  const write = (file: string, source: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  };
  write("alchemy.run.ts", 'import { settings } from "./settings.ts"; new URL("./src/router.ts", import.meta.url); export default settings;');
  write("settings.ts", 'export const settings = { region: "eu" };');
  write("src/router.ts", 'import type { $ElementId } from "../scripts/architecture/gen/model.ts"; export default {};');
  return { root, write };
}
test("the stack fingerprint is independent of the checkout path", () => {
  expect(stackFingerprint(fixture().root)).toBe(stackFingerprint(fixture().root));
});
test("resource settings and referenced configuration change the fingerprint", () => {
  const { root, write } = fixture();
  const before = stackFingerprint(root);
  write("settings.ts", 'export const settings = { region: "other" };');
  expect(stackFingerprint(root)).not.toBe(before);
});
test("runtime source URLs and carried patches participate in the fingerprint", () => {
  const { root, write } = fixture();
  const before = stackFingerprint(root);
  write("src/router.ts", "export default { fetch() {} };");
  const changed = stackFingerprint(root);
  expect(changed).not.toBe(before);
  write("patches/change.patch", "deployment change");
  expect(stackFingerprint(root)).not.toBe(changed);
});
test("generated model types cannot feed back into deployment generation", () => {
  const { root, write } = fixture();
  const before = stackFingerprint(root);
  write("scripts/architecture/gen/model.ts", 'export type $ElementId = "gateway";');
  expect(stackFingerprint(root)).toBe(before);
});


test("deployment environment mapping participates even when resource names do not change", () => {
  const { root, write } = fixture();
  const before = stackFingerprint(root);
  write("scripts/environment.ts", 'export const deployment = { region: "changed" };');
  expect(stackFingerprint(root)).not.toBe(before);
});
