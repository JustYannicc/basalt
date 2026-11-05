import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";

export const isRelativeInput = (file: string) =>
  file.length > 0 &&
  !file.startsWith("/") &&
  !file.split("/").some((part) => part === ".." || part === ".");

export function carryTargets(patch: string) {
  const diffs = patch.split("\n").filter((line) => line.startsWith("diff --git "));
  const targets = new Set(
    diffs.flatMap((line) => {
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!match || !isRelativeInput(match[1]!) || !isRelativeInput(match[2]!))
        throw new Error("Unsupported carry target path");
      return [match[1]!, match[2]!];
    }),
  );
  // Git parses unified headers and hunk bodies without applying any source changes.
  const scratch = mkdtempSync(join(tmpdir(), "basalt-carry-inputs-"));
  try {
    const file = join(scratch, "carry.patch");
    writeFileSync(file, patch);
    const parsed = spawnSync("git", ["apply", "--numstat", "-z", "--allow-empty", file], {
      cwd: scratch,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (parsed.error || parsed.status !== 0) throw new Error("Unsupported carry target path");
    for (const record of parsed.stdout.split("\0").filter(Boolean)) {
      const match = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/.exec(record);
      if (!match || !isRelativeInput(match[1]!)) throw new Error("Unsupported carry target path");
      targets.add(match[1]!);
    }
    if (!targets.size) throw new Error("Changed carry has no target files");
    return [...targets].map((target) => ".upstream/" + target);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

const repositoryInputs = new Map<string, Set<string>>();

function frozenRepositoryInputs(root: string) {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const key = JSON.stringify([root, head]);
  const previous = repositoryInputs.get(key);
  if (previous) return previous;
  const source = git(["ls-tree", "-r", "--name-only", "-z", head]).split("\0").filter(Boolean);
  const files = new Set(source);
  const patches = source.filter((file) => /^patches\/[^/]+\.patch$/.test(file));
  if (patches.length) {
    const carried = execFileSync("git", ["show", ...patches.map((file) => head + ":" + file)], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const target of carryTargets(carried)) files.add(target);
  }
  repositoryInputs.set(key, files);
  return files;
}

export function frozenInputMatcher(root: string) {
  const files = new Set([
    ...frozenRepositoryInputs(root),
    ...upstreamInputFiles(root).map((file) => ".upstream/" + file),
  ]);
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
