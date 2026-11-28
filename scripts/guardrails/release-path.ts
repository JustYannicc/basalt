import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

type Reasoned = { readonly path: string; readonly why: string };
const list = JSON.parse(readFileSync(new URL("./release-path.json", import.meta.url), "utf8")) as {
  paths: string[];
  cuts?: Reasoned[];
  decided?: Reasoned[];
  laneModules?: string[];
};

// One list decides what "the release path" is; every guardrail reads it from here.
export const releasePaths: readonly string[] = list.paths;
/** Where the release closure check stops walking imports, each with its reason. */
export const releaseCuts: readonly Reasoned[] = list.cuts ?? [];
/** Files a release reaches that are not release path, each with its reason. */
export const releaseDecided: readonly Reasoned[] = list.decided ?? [];
/** Decided pool modules a release-path file imports directly: the guard names a change to one. */
export const laneModules: readonly string[] = list.laneModules ?? [];

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
  execFileSync("git", ["-c", "core.quotePath=false", ...args, "-z"], {
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
