import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

test("container context inputs from every stage participate in deployment drift", () => {
  const { root, write } = fixture();
  write("alchemy.run.ts", 'new URL("./containers/pool/", import.meta.url);');
  write("containers/pool/Dockerfile", "FROM python AS build\nCOPY releases.json fetch.py ./\nFROM python\nCOPY runtime.py ./\n");
  write("containers/pool/releases.json", "{}");
  write("containers/pool/fetch.py", "# release acquisition");
  write("containers/pool/runtime.py", "# runtime");
  for (const file of ["releases.json", "fetch.py", "runtime.py", "Dockerfile"]) {
    const before = stackFingerprint(root);
    const path = `containers/pool/${file}`;
    write(path, readFileSync(join(root, path), "utf8") + "\n# changed\n");
    expect(stackFingerprint(root), file).not.toBe(before);
  }
});

test("referenced public assets hash their bytes and include newly added files", () => {
  const { root, write } = fixture();
  write("alchemy.run.ts", 'new URL("./public/", import.meta.url);');
  write("public/logo.png", "");
  writeFileSync(join(root, "public/logo.png"), Buffer.from([0xff]));
  const before = stackFingerprint(root);
  writeFileSync(join(root, "public/logo.png"), Buffer.from([0xfe]));
  const changed = stackFingerprint(root);
  expect(changed).not.toBe(before);
  write("public/redirects", "/old /new 302");
  expect(stackFingerprint(root)).not.toBe(changed);
});
