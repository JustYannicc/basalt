import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

// One list decides what "the release path" is; every guardrail reads it from here.
export const releasePaths: readonly string[] = JSON.parse(
  readFileSync(new URL("./release-path.json", import.meta.url), "utf8"),
).paths;

// The list as a given commit had it. Gates judge with the union of the lists on both sides of a
// change, so narrowing the list cannot take a change off the release path.
export function releasePathsAt(root: string, commit: string): string[] {
  try {
    const text = execFileSync("git", ["show", `${commit}:scripts/guardrails/release-path.json`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(text).paths;
  } catch (error) {
    if (
      /does not exist|exists on disk, but not in/u.test(
        String((error as { stderr?: string }).stderr),
      )
    )
      return [];
    throw error;
  }
}

export const unionOfPaths = (...lists: readonly (readonly string[])[]) => [
  ...new Set(lists.flat()),
];

export function onReleasePath(file: string, paths: readonly string[] = releasePaths): boolean {
  return paths.some((pattern) => matchesGlob(file, pattern));
}

// -z keeps unusual file names unquoted, so every release-path file is matched.
const gitRecords = (root: string, args: string[]) =>
  execFileSync("git", ["-c", "core.quotePath=false", args[0]!, "-z", ...args.slice(1)], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 << 20,
  }).split("\0");

// Covers path, mode and blob of every release-path file, so two commits share the hash
// exactly when their release path is byte-identical, whatever else changed.
export function releasePathHash(
  root: string,
  commit: string,
  paths: readonly string[] = releasePaths,
): string {
  // Narrow the listing to each glob's literal directory or file; the glob itself still decides.
  const prefixes = paths.map((pattern) =>
    pattern.includes("*") ? pattern.slice(0, pattern.indexOf("*")).replace(/[^/]*$/, "") : pattern,
  );
  const pathspecs = prefixes.includes("") ? [] : ["--", ...new Set(prefixes)];
  const entries = gitRecords(root, ["ls-tree", "-r", "--full-tree", commit, ...pathspecs])
    .filter((line) => line && onReleasePath(line.slice(line.indexOf("\t") + 1), paths))
    .sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export type PathChange = { files: number; added: number; removed: number };

export function releasePathChange(
  root: string,
  from: string,
  to: string,
  paths: readonly string[] = releasePaths,
): PathChange {
  const change = { files: 0, added: 0, removed: 0 };
  for (const record of gitRecords(root, [
    "diff-tree",
    "-r",
    "--numstat",
    "--no-renames",
    from,
    to,
  ])) {
    const [added, removed, file] = record.split("\t");
    if (!file || !onReleasePath(file, paths)) continue;
    change.files += 1;
    change.added += Number(added) || 0;
    change.removed += Number(removed) || 0;
  }
  return change;
}
