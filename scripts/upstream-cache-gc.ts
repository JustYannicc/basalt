import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { processOwnerAlive } from "./process-owner.ts";
import { upstreamCache } from "./upstream-cache.ts";
import { patchedTreeUse } from "./upstream-carries.ts";

const inside = (parent: string, path: string) => path === parent || path.startsWith(parent + sep);
const retiredName = /^\.gc-[0-9a-f-]{36}$/;
const directories = (path: string) =>
  existsSync(path)
    ? readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(path, entry.name))
    : [];

/**
 * The identity of a checkout's `.bun` link directory: replacing any link changes its mtime, and
 * replacing the tree changes its inode. A whole-second mtime may come from a coarse clock, where a
 * later change could keep it, so it proves nothing.
 */
export function linkFingerprint(bun: string) {
  const stat = lstatSync(bun, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.mtimeNs % 1_000_000_000n === 0n) return undefined;
  return { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs) };
}

const sameLinks = (recorded: unknown, bun: string) => {
  const current = linkFingerprint(bun);
  return (
    current !== undefined &&
    typeof recorded === "object" &&
    recorded !== null &&
    (["dev", "ino", "mtimeNs"] as const).every(
      (field) => (recorded as Record<string, unknown>)[field] === current[field],
    )
  );
};

function references(prepared: string) {
  const found = new Set<string>();
  const add = (path: string) => {
    try {
      const actual = realpathSync(path);
      if (inside(prepared, actual)) found.add(actual);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const checkout = (root: string) => {
    const marker = join(root, ".basalt-dependencies.json");
    let covered = false;
    if (existsSync(marker)) {
      const record: unknown = JSON.parse(readFileSync(marker, "utf8"));
      if (
        typeof record !== "object" ||
        record === null ||
        !("store" in record) ||
        typeof record.store !== "string"
      )
        throw new Error("Invalid registered dependency reference");
      add(record.store);
      covered = sameLinks(
        "links" in record ? record.links : undefined,
        join(root, "node_modules/.bun"),
      );
    }
    // A legacy install can replace package links before updating its marker. Links unchanged since
    // their install wrote this marker point only into its store, which is already protected.
    const modules = join(root, "node_modules");
    if (!existsSync(modules)) return;
    if (lstatSync(modules).isSymbolicLink()) add(realpathSync(modules));
    else if (covered) return;
    const bun = join(modules, ".bun");
    if (existsSync(bun))
      for (const entry of readdirSync(bun)) {
        const path = join(bun, entry);
        if (lstatSync(path).isSymbolicLink()) add(resolve(dirname(path), readlinkSync(path)));
      }
  };
  const repositories = [
    fileURLToPath(new URL("../", import.meta.url)),
    ...directories(join(upstreamCache(), "repositories")),
  ];
  for (const repository of repositories) {
    const result = spawnSync("git", ["-C", repository, "worktree", "list", "--porcelain", "-z"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error("Cannot observe registered dependency worktrees");
    for (const field of result.stdout.split("\0"))
      if (field.startsWith("worktree ")) {
        const root = field.slice("worktree ".length);
        if (existsSync(root)) {
          checkout(root);
          checkout(join(root, ".upstream"));
        }
      }
  }
  // One kernel snapshot avoids recursively walking every multi-gigabyte key with lsof +D.
  const handles = spawnSync("lsof", ["-nP", "-F0n"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (handles.status !== 0 || handles.stderr.trim())
    throw new Error("Cannot observe open dependency files");
  for (const field of handles.stdout.split("\0")) {
    const name = field.replace(/^\n+/, "");
    if (name.startsWith("n")) {
      const path = name.slice(1).replace(/ \(deleted\)$/, "");
      if (inside(prepared, path)) found.add(path);
    }
  }
  return found;
}

function currentGeneration(entry: string) {
  try {
    const store = realpathSync(join(entry, "current"));
    if (inside(join(entry, "generations"), store) && existsSync(join(store, "ready.json")))
      return store;
  } catch (error) {
    if (!["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function removeRetired(path: string) {
  const writable = (directory: string) => {
    chmodSync(directory, 0o755);
    for (const child of directories(directory)) writable(child);
  };
  writable(path);
  rmSync(path, { recursive: true });
}

/** Plan every protection before deleting anything. The caller holds collection.lock. */
export function preparedCacheCollection(stores: ReadonlySet<string>, attempts: readonly string[]) {
  try {
    const location = resolve(upstreamCache(), "prepared");
    const prepared = existsSync(location) ? realpathSync(location) : location;
    const paths = new Set([...stores, ...attempts, ...references(prepared)]);
    const protectedPath = (path: string) =>
      [...paths].some((reference) => inside(path, reference) || inside(reference, path));
    const all = directories(prepared).flatMap(directories);
    const entries = all.filter((path) => !retiredName.test(basename(path)));
    const locked = new Set<string>();
    for (const entry of entries) {
      // Legacy installers create sibling attempts while holding the parent key's lock.
      const owner = entry.replace(/\.attempt-[0-9a-f-]{36}$/, "");
      for (const suffix of [".lock", ".lock.recovery"])
        try {
          if (processOwnerAlive(JSON.parse(readlinkSync(owner + suffix)))) locked.add(entry);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    const current = new Map(entries.map((entry) => [entry, currentGeneration(entry)]));
    const evicted = new Set(entries.filter((entry) => !locked.has(entry) && !protectedPath(entry)));
    const retained = new Set(entries.filter((entry) => !evicted.has(entry)));
    const preserved = new Set([...retained].flatMap((entry) => current.get(entry) ?? []));
    const retired = all.filter((path) => retiredName.test(basename(path)) && !protectedPath(path));
    return {
      protectedPath,
      preserved,
      evicted,
      owns: (path: string) => [...evicted].some((entry) => inside(entry, path)),
      finish: () => {
        for (const entry of evicted) {
          const target = join(dirname(entry), `.gc-${randomUUID()}`);
          renameSync(entry, target);
          retired.push(target);
        }
        for (const path of retired)
          try {
            removeRetired(path);
          } catch {
            // A retired name is never a cache hit, even when deletion is interrupted.
            console.warn("Prepared cache cleanup will retry a retired tree on the next prepare.");
          }
      },
    };
  } catch {
    // Missing or incomplete process/worktree evidence cannot authorize a partial collection pass.
    console.warn("Prepared cache cleanup skipped because usage could not be verified.");
    return;
  }
}

/** Keeps each cache repository's most recently used patched trees; an evicted tree costs one replay. */
export function collectPatchedTrees(keep = 32) {
  for (const repository of directories(join(upstreamCache(), "repositories"))) {
    const listed = spawnSync(
      "git",
      [
        "-C",
        repository,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/basalt/patched/",
      ],
      { encoding: "utf8" },
    );
    if (listed.status !== 0) continue;
    const trees = listed.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref = "", object = ""] = line.split(" ");
        const key = basename(ref);
        const use = statSync(patchedTreeUse(repository, key), { throwIfNoEntry: false });
        return { ref, object, key, used: use?.mtimeMs ?? 0 };
      })
      .sort((a, b) => b.used - a.used);
    for (const { ref, object, key } of trees.slice(keep)) {
      // A conditional delete never removes a ref that changed after it was listed.
      spawnSync("git", ["-C", repository, "update-ref", "-d", ref, object]);
      rmSync(patchedTreeUse(repository, key), { force: true });
    }
    const kept = new Set(trees.slice(0, keep).map(({ key }) => key));
    const uses = patchedTreeUse(repository);
    if (existsSync(uses))
      for (const key of readdirSync(uses))
        if (!kept.has(key)) rmSync(join(uses, key), { force: true });
  }
}
