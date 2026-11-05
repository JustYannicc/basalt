import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

export const isRelativeInput = (file: string) =>
  file.length > 0 &&
  !file.startsWith("/") &&
  !file.split("/").some((part) => part === ".." || part === ".");

export function carryTargets(patch: string) {
  const diffs = patch.split("\n").filter((line) => line.startsWith("diff --git "));
  if (!diffs.length) throw new Error("Changed carry has no target files");
  return diffs.flatMap((line) => {
    const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (!match || !isRelativeInput(match[1]!) || !isRelativeInput(match[2]!))
      throw new Error("Unsupported carry target path");
    return [...new Set([match[1]!, match[2]!])].map((target) => ".upstream/" + target);
  });
}

export function upstreamInputFiles(root: string) {
  // Selection precedes upstream preparation; check-plans verifies this snapshot against the pin's Git tree.
  const snapshot = JSON.parse(
    readFileSync(join(root, "scripts/ci/upstream-files.json"), "utf8"),
  ) as {
    pin: string;
    files: string[];
  };
  const pin = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")).commit;
  if (
    !/^[a-f0-9]{40}$/.test(pin) ||
    snapshot.pin !== pin ||
    !Array.isArray(snapshot.files) ||
    !snapshot.files.every((file) => typeof file === "string" && isRelativeInput(file)) ||
    new Set(snapshot.files).size !== snapshot.files.length
  )
    throw new Error("Invalid or stale frozen upstream input inventory");
  return snapshot.files;
}

export function frozenInputMatcher(root: string) {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const files = new Set([
    ...git(["ls-tree", "-r", "--name-only", "-z", head]).split("\0").filter(Boolean),
    ...upstreamInputFiles(root).map((file) => ".upstream/" + file),
  ]);
  const patches = spawnSync(
    "git",
    ["grep", "--no-textconv", "-h", "-e", "^diff --git ", head, "--", ":(top,glob)patches/*.patch"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (patches.error || (patches.status !== 0 && patches.status !== 1))
    throw new Error("Could not read frozen carry targets");
  if (patches.stdout.trim()) for (const target of carryTargets(patches.stdout)) files.add(target);
  const patterns = new Map<string, boolean>();
  return (pattern: string) => {
    if (!patterns.has(pattern)) {
      // Most inputs are literal paths; restrict glob scans to their literal prefix.
      const prefix = /^[\w./-]*/.exec(pattern)![0];
      patterns.set(
        pattern,
        files.has(pattern) ||
          [...files].some((file) => file.startsWith(prefix) && matchesGlob(file, pattern)),
      );
    }
    return patterns.get(pattern)!;
  };
}
