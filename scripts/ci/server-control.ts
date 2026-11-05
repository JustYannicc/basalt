import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Suite setup owns target-aware runtimes; scenario helpers must not inherit that exemption. */
const runtimeModules = new Set(["support/case.ts", "support/lifecycle.ts", "support/managed-server.ts", "test-plan.ts"]);

export function serverControlDependency(root: string, file: string) {
  const e2e = resolve(root, ".upstream/e2e");
  const seen = new Set<string>();
  const visit = (path: string): string[] | undefined => {
    const name = relative(e2e, path);
    if (seen.has(path) || name.startsWith("../") || name.startsWith("sdk/") || runtimeModules.has(name) || !existsSync(path))
      return undefined;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    if (/import\s*\{[^}]*\bserverControl\b[^}]*\}\s*from\s*["'][^"']*server-control\.ts["']/.test(source))
      return [name];
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
      const dependency = visit(resolve(dirname(path), match[1]!));
      if (dependency) return [name, ...dependency];
    }
    return undefined;
  };
  return visit(join(e2e, "tests", file));
}

export function assertAutomaticCloudControl(root: string, file: string, automatic: boolean) {
  if (!automatic) return;
  const dependency = serverControlDependency(root, file);
  if (dependency)
    throw new Error(
      `${file}: automatic declared:cloud assignments cannot use serverControl (${dependency.join(" -> ")}). ` +
      "Use self-host coverage. Existing explicit Cloud jobs with target-aware fixtures are outside this guard.",
    );
}
