import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { moduleErrors, sourceDependencies, type Module } from "./source.ts";
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "architecture-source-"));
  temporary.push(root);
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}
const module = (id: string, code: string): Module => ({ id, code, bindings: [], libraries: [] });

test("new package folders and deleted code are rejected", () => {
  const root = fixture({ "packages/new/index.ts": "export const value = 1" });
  expect(moduleErrors(root, [module("old", "packages/old")])).toEqual([
    "old: missing code packages/old", "Unmodelled module: packages/new", "Unmodelled code: packages/new/index.ts",
  ]);
});

test("relative and workspace package imports preserve their module endpoints", () => {
  const root = fixture({
    "packages/a/index.ts": "import type { b } from '../b/index.js'; import('@demo/b');",
    "packages/b/index.ts": "export const b = 1",
    "packages/b/package.json": '{"name":"@demo/b"}',
  });
  const result = sourceDependencies(root, [module("a", "packages/a"), module("b", "packages/b")], []);
  expect(result.errors).toEqual([]);
  expect(result.dependencies.map(d => `${d.source}->${d.target}`)).toEqual(["a->b", "a->b"]);
});

test("new outside hosts and SDKs fail, including template URLs and dynamic imports", () => {
  const root = fixture({ "src/router.ts": "fetch('https://unmodelled.invalid/v1'); const url = `https://other.invalid/${path}`; import('unmodelled-sdk');" });
  const result = sourceDependencies(root, [module("router", "src/router.ts")], []);
  expect(result.errors).toHaveLength(3);
  expect(result.errors.join("\n")).toContain("Unmodelled outside host: unmodelled.invalid");
  expect(result.errors.join("\n")).toContain("Unmodelled outside host: other.invalid");
  expect(result.errors.join("\n")).toContain("Unmodelled SDK or library: unmodelled-sdk");
});

test("host and SDK evidence resolves to the calling module", () => {
  const root = fixture({ "src/router.ts": "import api from '@demo/sdk'; fetch('https://api.example.invalid/v1')" });
  const result = sourceDependencies(root, [module("router", "src/router.ts")], [{ id: "service", hosts: ["api.example.invalid"], sdks: ["@demo/sdk"] }]);
  expect(result.errors).toEqual([]);
  expect(result.dependencies.map(d => `${d.source}->${d.target}`)).toEqual(["router->service", "router->service"]);
});

test("computed egress and undeclared service bindings cannot disappear from the check", () => {
  const root = fixture({ "src/router.ts": "fetch(destination); env.UNKNOWN.fetch(request);" });
  expect(sourceDependencies(root, [module("router", "src/router.ts")], []).errors).toHaveLength(2);
});


test("network SDKs and aliased fetch cannot bypass outside-service coverage", () => {
  const root = fixture({ "src/router.ts": "import { request } from 'node:https'; const send = fetch;" });
  const result = sourceDependencies(root, [module("router", "src/router.ts")], []);
  expect(result.errors).toHaveLength(2);
});


test("bound container and actor transports ignore placeholder HTTP hosts", () => {
  const root = fixture({ "src/router.ts": "container.getTcpPort(port).fetch('http://pool/ready'); singleton(env).fetch('http://pool/__warm');" });
  const caller = { ...module("gateway", "src/router.ts"), bindings: ["container.getTcpPort=runtime", "singleton=runtime"] };
  const result = sourceDependencies(root, [caller], []);
  expect(result.errors).toEqual([]);
  expect(result.dependencies.map(d => `${d.source}->${d.target}`)).toEqual(["gateway->runtime", "gateway->runtime"]);
});

test("declared runtime code outside conventional folders participates in source checks", () => {
  const root = fixture({ "brand.ts": "fetch('https://unmodelled.invalid/v1');", ".upstream/runtime.ts": "fetch(destination);" });
  const result = sourceDependencies(root, [module("router", "brand.ts"), module("tools", ".upstream")], []);
  expect(result.errors).toEqual(["brand.ts:1: Unmodelled outside host: unmodelled.invalid"]);
});
