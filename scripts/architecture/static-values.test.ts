import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import ts from "typescript";
import { StaticValues } from "./static-values.ts";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "architecture-static-values-"));
  temporary.push(root);
  const paths: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
    paths.push(path);
  }
  return { paths, values: new StaticValues(paths) };
}

function expressions(source: ts.SourceFile, predicate: (node: ts.CallExpression) => boolean): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && predicate(node) && node.arguments[0]) found.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("static hosts resolve through imported config and computed URL path values", () => {
  const { paths, values } = fixture({
    "brand.ts": `export const brand = { host: "app.example.test" } as const;`,
    "scripts/check.ts": [
      `import { brand } from "../brand.ts";`,
      `const account = process.env.ACCOUNT_ID;`,
      "const url = new URL(`https://${brand.host}/client/${account}`);",
      `url.searchParams.set("limit", "200");`,
      `fetch(url);`,
    ].join("\n"),
  });
  const source = values.source(paths[1]!);
  const [argument] = expressions(source!, call => call.expression.getText(source!) === "fetch");
  expect(values.urlHost(argument!)).toBe("app.example.test");
});

test("mutable, shadowed, and URL-host-mutated aliases stay unknown", () => {
  const { paths, values } = fixture({
    "scripts/check.ts": [
      `let destination = process.env.API_URL; fetch(destination);`,
      `const url = new URL("https://api.example.test/v1");`,
      `const alias = url; alias.hostname = process.env.API_HOST; fetch(url);`,
      `const escaped = new URL("https://api.example.test/v1"); rewrite(escaped); fetch(escaped);`,
      `const assigned = new URL("https://api.example.test/v1"); const assignedAlias = assigned; Object.assign(assignedAlias, { hostname: process.env.API_HOST }); fetch(assigned);`,
      `const origin = "https://api.example.test/v1";`,
      `function send(origin: string) { fetch(origin); }`,
    ].join("\n"),
  });
  const source = values.source(paths[0]!);
  const args = expressions(source!, call => call.expression.getText(source!) === "fetch");
  expect(args.map(argument => values.urlHost(argument))).toEqual([undefined, undefined, undefined, undefined, undefined]);
});

test("bounded URL proofs follow a regex-validated HTTPS host to a returned URL", () => {
  const { paths, values } = fixture({
    "src/telemetry.ts": [
      "function parseDsn(value: string) {",
      String.raw`  const match = /^https:\/\/([A-Za-z0-9_-]+)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.ingest\.de\.sentry\.io)\/(\d+)$/.exec(value);`,
      "  if (!match) return undefined;",
      "  const [, publicKey, host, projectId] = match;",
      "  const url = new URL(value);",
      "  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host.toLowerCase() || url.username !== publicKey || url.password !== '' || url.port !== '' || url.search !== '' || url.hash !== '' || url.pathname !== `/${projectId}`) return undefined;",
      "  return { publicKey, host: host.toLowerCase(), projectId };",
      "}",
      "function sentryTarget(env: { DSN: string }) {",
      "  const dsn = parseDsn(env.DSN);",
      "  if (!dsn) return undefined;",
      "  return { url: `https://${dsn.host}/api/${dsn.projectId}/envelope/` };",
      "}",
      "function otlpTarget(env: { DSN: string; ENDPOINT: string }) {",
      "  const dsn = parseDsn(env.DSN);",
      "  if (!dsn || !env.ENDPOINT) return undefined;",
      "  const url = new URL(env.ENDPOINT);",
      "  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '' || url.hash !== '' || url.hostname.toLowerCase() !== dsn.host) return undefined;",
      "  return { url: url.href };",
      "}",
      "const sentry = sentryTarget(env);",
      "const otlp = otlpTarget(env);",
      "fetch(sentry.url);",
      "fetch(otlp.url);",
    ].join("\n"),
  });
  const source = values.source(paths[0]!);
  const args = expressions(source!, call => call.expression.getText(source!) === "fetch");
  expect(args.map(argument => values.boundedUrlHost(argument))).toEqual([
    "*.ingest.de.sentry.io", "*.ingest.de.sentry.io",
  ]);
});

test("package-base URL resolution requires a bounded relative prefix", () => {
  const { paths, values } = fixture({
    "scripts/check.ts": [
      `const entry = import.meta.resolve("alchemy");`,
      "const nested = new URL(`Cloudflare/Workers/Sources/Rolldown${entry.endsWith('.ts') ? '.ts' : '.js'}`, new URL('./', entry));",
      `const unknown = new URL(computeURL(), new URL("./", entry));`,
      `const absolute = new URL("https://outside.example.test/module.js", new URL("./", entry));`,
      `import(nested.href); import(unknown.href); import(absolute.href);`,
    ].join("\n"),
  });
  const source = values.source(paths[0]!);
  const imports = expressions(source!, call => call.expression.kind === ts.SyntaxKind.ImportKeyword);
  expect(values.moduleSpecifier(imports[0]!)).toBe("alchemy");
  expect(values.packageSpecifier(imports[0]!)).toBe(true);
  expect(values.moduleSpecifier(imports[1]!)).toBeUndefined();
  expect(values.moduleSpecifier(imports[2]!)).toBe("https://outside.example.test/module.js");
  expect(values.packageSpecifier(imports[2]!)).toBe(false);
});
