import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { onReleasePath } from "./release-path.ts";

// A change to how releases are made ships alone, so a failed release can be traced to it and
// reverted without taking product work with it. Release-path files may travel only with the
// architecture model, the release docs and package.json (where the test globs live).
export const companions = ["architecture/**", "docs/releases.md", "package.json"];

export type ShipAlone = { pass: boolean; releasePath: string[]; other: string[] };

export function shipAlone(files: string[]): ShipAlone {
  const releasePath = files.filter((file) => onReleasePath(file));
  const other = files.filter(
    (file) => !onReleasePath(file) && !companions.some((pattern) => matchesGlob(file, pattern)),
  );
  return { pass: releasePath.length === 0 || other.length === 0, releasePath, other };
}

export function changedFiles(base: string, head: string): string[] {
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  })
    .split("\0")
    .filter(Boolean);
}

if (import.meta.main) {
  const [base = "origin/main", head = "HEAD"] = process.argv.slice(2);
  const result = shipAlone(changedFiles(base, head));
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
