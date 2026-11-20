// The gate's own code imports its tools by package name. A package.json or module placed on the
// way would resolve a name to code that reports nothing while every byte the gate records stays
// the same, so each name has to resolve into the lockfile install.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const BARE_IMPORT = /\bfrom\s+["']([^"'./][^"']*)["']/gu;
// Resolves each argument the way an ES module in the working directory imports it.
const RESOLVE =
  "for (const name of process.argv.slice(1)) { try { console.log(import.meta.resolve(name)); } catch { console.log(''); } }";

/** The package names each directory's code imports, Node built-ins aside. */
export function bareImports(sources: ReadonlyMap<string, string>) {
  const imports = new Map<string, Set<string>>();
  for (const [path, text] of sources)
    for (const [, name] of text.matchAll(BARE_IMPORT)) {
      if (name!.startsWith("node:")) continue;
      const names = imports.get(dirname(path)) ?? new Set<string>();
      imports.set(dirname(path), names.add(name!));
    }
  return imports;
}

const packageOf = (name: string) =>
  name
    .split("/")
    .slice(0, name.startsWith("@") ? 2 : 1)
    .join("/");

/** Imports that resolve anywhere but into `install`, each with where it went instead. */
export function resolutionProblems(
  install: string,
  imports: ReadonlyMap<string, ReadonlySet<string>>,
  root: string,
) {
  const problems: string[] = [];
  for (const [dir, names] of imports) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", RESOLVE, ...names], {
      cwd: dir,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      problems.push(
        `Could not resolve the imports of ${relative(root, dir)}: ${result.stderr.trim()}`,
      );
      continue;
    }
    const resolved = result.stdout.split("\n");
    [...names].forEach((name, index) => {
      const expected = join(install, packageOf(name));
      const prefix = existsSync(expected) ? `${pathToFileURL(realpathSync(expected)).href}/` : "";
      const actual = resolved[index] ?? "";
      if (prefix === "" || !actual.startsWith(prefix))
        problems.push(
          `${name}, imported in ${relative(root, dir)}/, resolves to ${actual || "nothing"} instead of the package installed in ${relative(root, install)}. Remove the package.json or module that shadows it.`,
        );
    });
  }
  return problems;
}
