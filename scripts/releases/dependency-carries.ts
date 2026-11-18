import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A carry that patches a third-party package (it edits upstream's patches/<package>@<version>.patch)
// is a fork nobody upstream knows about. Each one names the upstream issue or pull request that
// would retire it and who follows it. The entries that had neither when this started may be
// completed or removed, never added to: the frozen list in dependency-carries.test.ts only shrinks.
export type Entry = { packages: string[]; upstream: string | null; owner: string | null };
export type Registry = { carries: Record<string, Entry> };

const dependencyPatch = /^diff --git a\/patches\/(\S+)@[^@\s]+\.patch /gm;

export function patchedPackages(patch: string): string[] {
  const packages = new Set<string>();
  for (const match of patch.matchAll(dependencyPatch)) packages.add(decodeURIComponent(match[1]!));
  return [...packages].sort();
}

export function dependencyCarries(root: string): Map<string, string[]> {
  const carries = new Map<string, string[]>();
  for (const file of readdirSync(join(root, "patches")).filter((name) => name.endsWith(".patch"))) {
    const packages = patchedPackages(readFileSync(join(root, "patches", file), "utf8"));
    if (packages.length) carries.set(file.replace(/\.patch$/, ""), packages);
  }
  return carries;
}

export function carryErrors(
  carries: Map<string, string[]>,
  registry: Registry,
  unlinkedAllowed: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  for (const [stem, packages] of carries) {
    const entry = registry.carries[stem];
    if (!entry) {
      errors.push(
        `${stem} patches ${packages.join(", ")}: add it to scripts/releases/dependency-carries.json with the upstream issue or pull request and its owner`,
      );
      continue;
    }
    if ((!entry.upstream || !entry.owner) && !unlinkedAllowed.has(stem))
      errors.push(
        `${stem} patches ${packages.join(", ")}: name its upstream issue or pull request and its owner`,
      );
  }
  for (const stem of Object.keys(registry.carries))
    if (!carries.has(stem)) errors.push(`${stem} no longer patches a dependency: remove its entry`);
  return errors;
}
