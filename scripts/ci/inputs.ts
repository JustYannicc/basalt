import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob, posix } from "node:path";

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

/** Adds a value to the set a map keeps under a key. */
export const addTo = <K, V>(map: Map<K, Set<V>>, key: K, value: V) =>
  (map.get(key) ?? map.set(key, new Set()).get(key)!).add(value);

/** Every file below each directory of the given files, for whole-directory reads. */
export function directoryFiles(files: Iterable<string>) {
  const below = new Map<string, string[]>();
  for (const file of files)
    for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1)) {
      const directory = file.slice(0, at);
      (below.get(directory) ?? below.set(directory, []).get(directory)!).push(file);
    }
  return below;
}

/**
 * The files a pattern matches. Most patterns are literal paths, a lookup; a glob scans only the
 * files under its literal prefix.
 */
export function fileMatcher(files: Iterable<string>) {
  const set = new Set(files);
  const list = [...set];
  return (pattern: string) => {
    const prefix = /^[\w./-]*/.exec(pattern)![0];
    if (prefix === pattern) return set.has(pattern) ? [pattern] : [];
    return list.filter((file) => file.startsWith(prefix) && matchesGlob(file, pattern));
  };
}

/**
 * The repository files each carried upstream file names in the lines its carries add: imports,
 * spawned scripts, and files the e2e harness reads or bundles from the repository root. Carries
 * and test corrections are the only way upstream code names this repository, so preparation
 * builds exactly these into the product and the harness.
 */
export function carriedReferences(root: string, files: readonly string[]) {
  const tracked = new Set(files);
  const below = directoryFiles(files);
  const references = new Map<string, Set<string>>();
  const mention = /(?:\.{1,2}\/)+[\w@.-]+(?:\/[\w@.-]+)*\/?/g;
  for (const patch of files.filter((file) =>
    /^(?:patches\/\d{4}-[^/]+|e2e\/[^/]+)\.patch$/.test(file),
  )) {
    let target = "";
    for (const line of readFileSync(join(root, patch), "utf8").split("\n")) {
      const header = /^diff --git a\/\S+ b\/(\S+)$/.exec(line);
      // Only code names other files; carried patches, manifests and documents only mention them.
      if (header) target = /\.[cm]?[jt]sx?$/.test(header[1]!) ? ".upstream/" + header[1] : "";
      if (!target || !line.startsWith("+") || line.startsWith("+++")) continue;
      for (const [text] of line.matchAll(mention))
        // Relative to the file, to the upstream root its scripts run in, or to this repository.
        for (const base of [posix.dirname(target), ".upstream", "."]) {
          const path = posix.normalize(posix.join(base, text)).replace(/\/$/, "");
          if (path.startsWith("../") || path.startsWith(".upstream/")) continue;
          const found = tracked.has(path)
            ? [path]
            : path.includes("/")
              ? (below.get(path) ?? [])
              : [];
          for (const file of found) addTo(references, target, file);
        }
      // Other carried upstream files the line names, so a spec reaches what its helpers name.
      for (const [text] of line.matchAll(mention)) {
        const path = posix.normalize(posix.join(posix.dirname(target), text)).replace(/\/$/, "");
        if (path.startsWith(".upstream/") && path !== target) addTo(references, target, path);
      }
    }
  }
  return references;
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
  const matching = fileMatcher([
    ...frozenRepositoryInputs(root),
    ...upstreamInputFiles(root).map((file) => ".upstream/" + file),
  ]);
  const patterns = new Map<string, boolean>();
  return (pattern: string) => {
    if (!patterns.has(pattern)) patterns.set(pattern, matching(pattern).length > 0);
    return patterns.get(pattern)!;
  };
}
