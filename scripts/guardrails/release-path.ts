import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

// One list decides what "the release path" is; every guardrail reads it from here.
export const releasePaths: readonly string[] = JSON.parse(
  readFileSync(new URL("./release-path.json", import.meta.url), "utf8"),
).paths;

export function onReleasePath(file: string, paths = releasePaths): boolean {
  return paths.some((pattern) => matchesGlob(file, pattern));
}

// -z keeps unusual file names unquoted, so every release-path file is matched.
const gitRecords = (root: string, args: string[]) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args, "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 << 20,
  }).split("\0");

// Covers path, mode and blob of every release-path file, so two commits share the hash
// exactly when their release path is byte-identical, whatever else changed.
export function releasePathHash(root: string, commit: string, paths = releasePaths): string {
  const entries = gitRecords(root, ["ls-tree", "-r", "--full-tree", commit])
    .filter((line) => line && onReleasePath(line.slice(line.indexOf("\t") + 1), paths))
    .sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export type PathChange = { files: number; added: number; removed: number };

export function releasePathChange(
  root: string,
  from: string,
  to: string,
  paths = releasePaths,
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
