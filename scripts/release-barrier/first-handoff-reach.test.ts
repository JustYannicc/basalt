// The legacy first handoff builds PoolWorker versions with declarative `exports`. PoolWorker is an
// alchemy, migrations-based Worker, which can never also take `exports`, so that builder must never
// run against it. Today nothing in production imports it; this walks every production entry point's
// static import graph and fails the moment one does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const testOnly = (path: string) => /\.test\.|(^|\/)test\/|(^|\/)e2e\//u.test(path);

/** Every script a workflow runs, directly or through an `npm run` script it names. */
function productionEntries() {
  const scripts: Record<string, string> = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).scripts;
  const paths = (text: string) =>
    [
      ...text.matchAll(
        /(?:\.\/)?((?:scripts|src|apps)\/[\w./-]+\.(?:ts|mjs|js)|alchemy\.[\w.]+\.ts)/gu,
      ),
    ].map((match) => match[1]!);
  const entries = new Set<string>(["alchemy.run.ts"]);
  const workflows = join(root, ".github/workflows");
  for (const name of readdirSync(workflows).filter((file) => /\.ya?ml$/u.test(file))) {
    const text = readFileSync(join(workflows, name), "utf8");
    for (const path of paths(text)) entries.add(path);
    for (const match of text.matchAll(/npm run ([\w:-]+)/gu))
      for (const path of paths(scripts[match[1]!] ?? "")) entries.add(path);
  }
  return [...entries].filter((path) => !testOnly(path) && existsSync(join(root, path)));
}

const specifiers = (source: string) =>
  [
    ...source.matchAll(/(?:^|[;\s])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/gu),
    ...source.matchAll(/(?:^|[;\s])import\s*["']([^"']+)["']/gu),
    ...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/gu),
  ].map((match) => match[1]!);

/** Relative and repository-root imports only; `.upstream` is a separate tree that cannot import back. */
function reachable(entries: readonly string[]) {
  const seen = new Set<string>();
  const queue = entries.map((path) => resolve(root, path));
  while (queue.length) {
    const file = queue.pop()!;
    const path = relative(root, file);
    if (seen.has(path) || path.startsWith(".upstream/") || path.includes("node_modules/")) continue;
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    seen.add(path);
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      for (const candidate of [target, `${target}.ts`, join(target, "index.ts")])
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          queue.push(candidate);
          break;
        }
    }
  }
  return seen;
}

test("the legacy first-handoff Worker builder is unreachable from every production entry point", () => {
  const entries = productionEntries();
  const graph = reachable(entries);
  // The walk is not vacuous: it finds the release entry and the handoff reader it really uses.
  for (const live of [
    "scripts/release-barrier/entry.ts",
    "scripts/release-barrier/runtime-image-release.ts",
    "scripts/release-barrier/runtime-release-bootstrap.ts",
    "scripts/release-barrier/first-handoff-runtime.ts",
    "src/pool/deployment.ts",
  ])
    assert.ok(graph.has(live), `${live} should be reachable from production`);
  for (const legacy of [
    "scripts/release-barrier/first-handoff-worker.ts",
    "scripts/release-barrier/first-handoff.ts",
    "scripts/release-barrier/first-handoff-cloudflare.ts",
    "scripts/release-barrier/first-handoff-service.ts",
  ])
    assert.ok(
      !graph.has(legacy),
      `${legacy} became reachable from production; it uploads PoolWorker with declarative exports`,
    );
});
