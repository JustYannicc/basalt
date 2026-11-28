import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import {
  companionsAt,
  laneModules,
  onReleasePath,
  releaseCompanions,
  releasePaths,
  releasePathsAt,
  sharedOf,
  unionOfPaths,
} from "./release-path.ts";

// A change to how releases are made ships alone, so a failed release can be traced to it and
// reverted without taking product work with it. Release-path files may travel only with the
// companions release-path.json names: the architecture model, the release docs, package.json
// (where the test globs live), the TypeScript project files, test files and their fixtures, and
// the dependency-carries record.
export const companions = releaseCompanions;

export type ShipAlone = { pass: boolean; releasePath: string[]; other: string[] };

// A test of a release-path file (`x.test.ts` beside `x.ts`) travels with it.
const testOf = (file: string, paths: readonly string[]) =>
  /\.test\./u.test(file) && onReleasePath(file.replace(".test.", "."), paths);

export function shipAlone(
  files: string[],
  paths: readonly string[] = releasePaths,
  travel: readonly string[] = companions,
): ShipAlone {
  const releasePath = files.filter((file) => onReleasePath(file, paths));
  const other = files.filter(
    (file) =>
      !onReleasePath(file, paths) &&
      !testOf(file, paths) &&
      !travel.some((pattern) => matchesGlob(file, pattern)),
  );
  return { pass: releasePath.length === 0 || other.length === 0, releasePath, other };
}

/**
 * Pool modules the fleet lane imports directly. They are not release path, since they are pool
 * Worker code, but a change to one can change what the lane does, so the guard names them.
 */
export const laneTouches = (files: readonly string[], modules: readonly string[] = laneModules) =>
  files.filter((file) => modules.includes(file));

/** The information line for a change that touches them, or none. Never a failure by itself. */
export function laneLine(files: readonly string[], modules: readonly string[] = laneModules) {
  const touched = laneTouches(files, modules);
  if (!touched.length) return undefined;
  const names = touched.slice(0, 20).join(", ") + (touched.length > 20 ? ", …" : "");
  return `Touches ${touched.length} ${touched.length === 1 ? "module" : "modules"} the fleet lane imports: ${names}.`;
}

export function changedFiles(base: string, head: string, cwd = "."): string[] {
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  })
    .split("\0")
    .filter(Boolean);
}

const isAncestor = (ancestor: string, of: string, cwd: string) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, of], { cwd, stdio: "ignore" });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
};

// A stacked batch carries the batches below it until they merge, and each of those is judged by
// its own pull request. So a batch branch is judged from the nearest batch branch below it that
// is not on main yet. This holds only while stacks merge bottom-up, each batch as its own merge.
export function comparisonBase(base: string, head: string, headRef: string, cwd = "."): string {
  if (!headRef.startsWith("batch/")) return base;
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const tip = git(["rev-parse", head]);
  let below: string | null = null;
  for (const line of git([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/remotes/origin/batch/",
  ]).split("\n")) {
    const [ref, sha] = line.split(" ");
    if (!sha || ref === `refs/remotes/origin/${headRef}` || sha === tip) continue;
    if (!isAncestor(sha, tip, cwd) || isAncestor(sha, base, cwd)) continue;
    if (!below || isAncestor(below, sha, cwd)) below = sha;
  }
  return below ?? base;
}

// The batch's own files: changed since the batch below, and not brought in by merging main.
export function batchFiles(main: string, base: string, head: string, cwd = "."): string[] {
  const sinceMain = new Set(changedFiles(main, head, cwd));
  return base === main
    ? [...sinceMain]
    : changedFiles(base, head, cwd).filter((file) => sinceMain.has(file));
}

if (import.meta.main) {
  const [main = "origin/main", head = "HEAD"] = process.argv.slice(2);
  const base = comparisonBase(main, head, process.env.HEAD_REF ?? "");
  if (base !== main) console.log(`Judged from the batch below, ${base.slice(0, 12)}.`);
  // Every side's list, so a change that narrows release-path.json is still judged by the old one.
  const paths = unionOfPaths(
    releasePathsAt(".", main),
    releasePathsAt(".", base),
    releasePathsAt(".", head),
  );
  const files = batchFiles(main, base, head);
  const travel = sharedOf(
    companionsAt(".", main),
    companionsAt(".", base),
    companionsAt(".", head),
  );
  const result = shipAlone(files, paths.length ? paths : releasePaths, travel);
  // Information only: never fails the check by itself.
  const lane = laneLine(files);
  if (lane) console.log(lane);
  if (result.pass) {
    console.log(
      result.releasePath.length
        ? `Release-path change shipping alone: ${result.releasePath.length} files.`
        : "No release-path files changed.",
    );
  } else {
    const list = (files: string[]) =>
      files.slice(0, 20).join(", ") + (files.length > 20 ? ", …" : "");
    console.log(
      `::error::Release-path changes ship alone. This change touches ${result.releasePath.length} release-path files (${list(result.releasePath)}) and ${result.other.length} other files (${list(result.other)}). Split the release-path files into their own pull request; scripts/guardrails/release-path.json lists the release path.`,
    );
    process.exitCode = 1;
  }
}
