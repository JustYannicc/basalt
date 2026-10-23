import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { filesBelow } from "./files.ts";

// Tests and the architecture checker are verification programs. Product build,
// provisioning and runtime programs all belong to the checked execution surface.
export function isExecutionPath(file: string): boolean {
  return file !== ".upstream" && !file.startsWith(".upstream/") &&
    file !== "scripts/architecture" && !file.startsWith("scripts/architecture/") &&
    !/(?:^|\/)(?:node_modules|tests?|__tests__|[^/]*-tests)(?:\/|$)/.test(file) &&
    !/\.(?:test|spec)\.|\.d\.ts$/.test(file) &&
    !/(?:^|\/)(?:test_.*|.*_test)\.py$/.test(file);
}

export function executionFiles(root: string, modules: readonly { code: string }[] = []): string[] {
  const paths = new Set<string>();
  const include = (path: string): void => {
    const file = relative(root, path).replaceAll("\\", "/");
    if (file === ".." || file.startsWith("../")) throw new Error("Execution source path escapes repository");
    if (!isExecutionPath(file)) return;
    for (const entry of filesBelow(path)) {
      const candidate = relative(root, entry).replaceAll("\\", "/");
      if (isExecutionPath(candidate) && /\.(?:[cm]?[jt]sx?|py)$/.test(entry)) paths.add(entry);
    }
  };
  for (const directory of ["src", "packages", "containers", "scripts"]) include(join(root, directory));
  if (existsSync(root)) for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (!entry.startsWith(".") && statSync(path).isFile() && /\.(?:[cm]?[jt]sx?|py)$/.test(entry)) include(path);
  }
  for (const module of modules) include(resolve(root, module.code));
  return [...paths].sort();
}
