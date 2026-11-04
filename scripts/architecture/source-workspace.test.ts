import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { sourceDependencies, type Module } from "./source.ts";
import { SourceWorkspace } from "./source-workspace.ts";

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "source-workspace-"));
  temporary.push(root);
  const write = (file: string, text: string) => {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  return { root, write };
}
const module = (id: string, code: string): Module => ({ id, code, bindings: [], libraries: [] });

test("shared syntax preserves independent service checks and rereads changed imported source", () => {
  const f = fixture();
  f.write("src/config.ts", 'export const url = "https://first.invalid/";');
  f.write("src/send.ts", 'import { url } from "./config.ts"; fetch(url);');
  const workspace = new SourceWorkspace();
  const paths = [join(f.root, "src/config.ts"), join(f.root, "src/send.ts")];
  const parsed = workspace.read(f.root, paths);
  expect(workspace.read(f.root, paths)).toBe(parsed);
  const modules = [module("sender", "src")];
  const services = [{ id: "outside", hosts: ["first.invalid"], sdks: [] }];
  const scan = (allowed = services) => sourceDependencies(f.root, modules, allowed, workspace);
  const original = scan();
  expect(original.errors).toEqual([]);
  expect(original.dependencies.map((d) => d.target)).toEqual(["outside", "outside"]);
  expect(scan([]).errors).toEqual(sourceDependencies(f.root, modules, []).errors);
  expect(scan()).toEqual(original);
  f.write("src/config.ts", 'export const url = "https://other.invalid/";');
  expect(workspace.read(f.root, paths)).not.toBe(parsed);
  expect(scan()).toEqual(sourceDependencies(f.root, modules, services));
  expect(scan().errors.join("\n")).toContain("Unmodelled outside host: other.invalid");
});

test("new, renamed and deleted files and package manifest edits invalidate the parsed snapshot", () => {
  const f = fixture();
  f.write("packages/a/index.ts", 'import "@demo/b";');
  f.write("packages/b/index.ts", "export const value = 1;");
  f.write("packages/b/package.json", '{"name":"@demo/b"}');
  const modules = [module("a", "packages/a"), module("b", "packages/b")];
  const workspace = new SourceWorkspace();
  const scan = () => sourceDependencies(f.root, modules, [], workspace);
  expect(scan().dependencies.map((d) => d.target)).toEqual(["b"]);
  f.write("packages/b/package.json", '{"name":"@demo/renamed"}');
  expect(scan().errors.join("\n")).toContain("Unmodelled SDK or library: @demo/b");
  f.write("packages/a/new.ts", 'fetch("https://new.invalid/");');
  expect(scan().errors.join("\n")).toContain("packages/a/new.ts:1:");
  renameSync(join(f.root, "packages/a/new.ts"), join(f.root, "packages/a/renamed.ts"));
  expect(scan().errors.join("\n")).toContain("packages/a/renamed.ts:1:");
  rmSync(join(f.root, "packages/a/renamed.ts"));
  expect(scan()).toEqual(sourceDependencies(f.root, modules, []));
  expect(scan().errors).toHaveLength(1);
});

test("shared Python syntax preserves service attribution and invalidates changed source", () => {
  const f = fixture();
  f.write("containers/tool/main.py", 'import requests\nrequests.get("https://first.invalid/")\n');
  const modules = [module("tool", "containers/tool")];
  const services = [{ id: "outside", hosts: ["first.invalid"], sdks: ["requests"] }];
  const workspace = new SourceWorkspace();
  const scan = (allowed = services) => sourceDependencies(f.root, modules, allowed, workspace);
  expect(scan().errors).toEqual([]);
  expect(scan([])).toEqual(sourceDependencies(f.root, modules, []));
  f.write("containers/tool/main.py", 'import requests\nrequests.get("https://other.invalid/")\n');
  expect(scan()).toEqual(sourceDependencies(f.root, modules, services));
  expect(scan().errors.join("\n")).toContain("Unmodelled outside host: other.invalid");
});
