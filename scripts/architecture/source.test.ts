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
const module = (id: string, code: string, extra: Partial<Module> = {}): Module => ({ id, code, bindings: [], libraries: [], ...extra });

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

test("owned deploy scripts and root entrypoints are checked while fixture and checker code stay excluded", () => {
  const root = fixture({
    "scripts/build.ts": "export const ready = true",
    "scripts/deploy.ts": "fetch('https://new-host.invalid/deploy');",
    "scripts/build-tests/example.test.ts": "fetch('https://fixture-only.invalid');",
    "scripts/architecture/check.ts": "fetch('https://checker-only.invalid');",
    "alchemy.run.ts": "export const ready = true",
    ".upstream/runtime.ts": "fetch(destination);",
  });
  const modules = [module("build", "scripts/build.ts"), module("deployment", "scripts/deploy.ts"), module("worker", "alchemy.run.ts")];
  expect(moduleErrors(root, modules)).toEqual([]);
  expect(sourceDependencies(root, modules, []).errors).toEqual([
    "scripts/deploy.ts:1: Unmodelled outside host: new-host.invalid",
  ]);
});

test("configuration URL values stay data and imports still produce module edges", () => {
  const root = fixture({
    "brand.ts": `export const brand = { host: "app.example.test", logo: "https://cdn.example.test/logo.png", links: { docs: null as string | null } } as const;`,
    "scripts/deploy.ts": `import { brand } from "../brand.ts";\nconsole.log(brand.host, brand.logo);`,
  });
  const modules = [
    module("brandConfig", "brand.ts", { configuration: true }),
    module("deployment", "scripts/deploy.ts"),
  ];
  const result = sourceDependencies(root, modules, []);
  expect(result.errors).toEqual([]);
  expect(result.dependencies.map(dependency => `${dependency.source}->${dependency.target}`)).toEqual(["deployment->brandConfig"]);
});

test("configuration calls fail the pure-data rule before URL data can be ignored", () => {
  const root = fixture({ "brand.ts": `export const brand = { host: fetch("https://new-host.invalid") };` });
  const result = sourceDependencies(root, [module("brandConfig", "brand.ts", { configuration: true })], []);
  expect(result.errors).toEqual(["brand.ts:1: Configuration modules allow only literal const declarations"]);
  expect(result.dependencies).toEqual([]);
});

test("computed fetch traces a const URL host with a dynamic path and query mutations", () => {
  const root = fixture({
    "scripts/ensure-artifacts.ts": "const account = process.env.ACCOUNT_ID;\nconst url = new URL(`https://api.example.test/client/${account}`);\nurl.searchParams.set('limit', '200');\nawait fetch(url);",
  });
  const result = sourceDependencies(
    root,
    [module("deployment", "scripts/ensure-artifacts.ts")],
    [{ id: "cloudflare", hosts: ["api.example.test"], sdks: [] }],
  );
  expect(result.errors).toEqual([]);
  expect(result.dependencies.map(dependency => `${dependency.source}->${dependency.target}`)).toEqual(["deployment->cloudflare"]);
});

test("unknown, reassigned, and shadowed computed fetch hosts fail closed", () => {
  const root = fixture({
    "scripts/unknown.ts": "export {}; const origin = `https://${process.env.API_HOST}/v1`; fetch(origin);",
    "scripts/reassigned.ts": "export {}; let destination = process.env.API_URL; destination = 'https://api.example.test/v1'; fetch(destination);",
    "scripts/shadowed.ts": "export {}; const origin = 'https://api.example.test/v1'; function send(origin: string) { return fetch(origin); }",
  });
  const result = sourceDependencies(
    root,
    [module("deployment", "scripts")],
    [{ id: "cloudflare", hosts: ["api.example.test"], sdks: [] }],
  );
  expect(result.errors.filter(error => error.includes("Computed outbound fetch"))).toEqual([
    "scripts/reassigned.ts:1: Computed outbound fetch needs a statically known host or an explicit gateway adapter",
    "scripts/shadowed.ts:1: Computed outbound fetch needs a statically known host or an explicit gateway adapter",
    "scripts/unknown.ts:1: Computed outbound fetch needs a statically known host or an explicit gateway adapter",
  ]);
  expect(result.errors.some(error => error.includes("Outside URL has a dynamic host"))).toBe(true);
});

test("smoke requests resolve the imported brand host to the modeled router endpoint", () => {
  const root = fixture({
    "brand.ts": `export const brand = { host: "app.example.test" } as const;`,
    "src/router.ts": "export const router = true;",
    "scripts/smoke.ts": [
      `import { brand } from "../brand.ts";`,
      "const origin = `https://${brand.host}`;",
      `const path = "/login";`,
      `await fetch(origin);`,
      "await fetch(`${origin}${path}`);",
    ].join("\n"),
  });
  const modules = [
    module("brandConfig", "brand.ts", { configuration: true }),
    module("router", "src/router.ts", { endpointHosts: ["app.example.test"] }),
    module("deployment", "scripts/smoke.ts"),
  ];
  const result = sourceDependencies(root, modules, []);
  expect(result.errors).toEqual([]);
  expect(new Set(result.dependencies.map(dependency => `${dependency.source}->${dependency.target}`))).toEqual(
    new Set(["deployment->brandConfig", "deployment->router"]),
  );
});

test("dynamic package imports resolve symbolically and enforce relative URLs", () => {
  const root = fixture({
    "scripts/pool-worker-build.ts": [
      `const entry = import.meta.resolve("alchemy");`,
      "const module = new URL(`Cloudflare/Workers/Sources/Rolldown${entry.endsWith('.ts') ? '.ts' : '.js'}`, new URL(\"./\", entry));",
      `await import(module.href);`,
    ].join("\n"),
  });
  const result = sourceDependencies(root, [module("build", "scripts/pool-worker-build.ts", { libraries: ["alchemy"] })], []);
  expect(result.errors).toEqual([]);
});

test("modeled provider SDKs win over generic framework imports", () => {
  const root = fixture({ "scripts/deploy.ts": `import "alchemy/Planetscale";` });
  const result = sourceDependencies(
    root,
    [module("deployment", "scripts/deploy.ts")],
    [{ id: "databaseProvider", hosts: [], sdks: ["alchemy/Planetscale"] }],
  );
  expect(result.errors).toEqual([]);
  expect(result.dependencies.map(dependency => `${dependency.source}->${dependency.target}`)).toEqual(["deployment->databaseProvider"]);
});

test("unknown and absolute URLs cannot inherit a package base for dynamic imports", () => {
  const root = fixture({
    "scripts/unknown.ts": `const entry = import.meta.resolve("alchemy"); await import(new URL(computeURL(), new URL("./", entry)).href);`,
    "scripts/absolute.ts": `const entry = import.meta.resolve("alchemy"); await import(new URL("https://outside.example.test/module.js", new URL("./", entry)).href);`,
  });
  const result = sourceDependencies(root, [module("build", "scripts", { libraries: ["alchemy"] })], []);
  expect(result.errors.some(error => error.includes("Dynamic import needs a statically known module"))).toBe(true);
  expect(result.errors.some(error => error.includes("Unmodelled SDK or library: https://outside.example.test/module.js"))).toBe(true);
  expect(result.errors.some(error => error.includes("Unmodelled outside host: outside.example.test"))).toBe(true);
});
