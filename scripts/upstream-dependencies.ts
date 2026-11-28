import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { digest, upstreamCache, withCacheLock } from "./upstream-cache.ts";
import { linkFingerprint } from "./upstream-cache-gc.ts";
import { dependencyIdentity } from "./upstream-inputs.ts";
import { omitReleaseLifecycles } from "./ci/dependency-lifecycles.ts";
import {
  abandonInstallAttempt,
  atomicStoreJson,
  collectDependencyStore,
  createInstallAttempt,
  installPrivateAttempt,
  rememberDependencyConsumer,
  withDependencyStoreLock,
} from "./upstream-store.ts";

function moduleTrees(root: string, directory = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || [".git", ".local", ".alchemy", ".generated"].includes(entry.name))
      continue;
    const path = join(directory, entry.name);
    if (entry.name === "node_modules") found.push(relative(root, path));
    else found.push(...moduleTrees(root, path));
  }
  return found;
}

function readyGeneration(store: string, key: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(store, "ready.json"), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as Record<string, unknown>;
  if (record.key !== key || !Array.isArray(record.trees) || !record.trees.includes("node_modules"))
    return;
  const trees: string[] = [];
  for (const tree of record.trees) {
    if (
      typeof tree !== "string" ||
      isAbsolute(tree) ||
      tree.split(/[\\/]/).some((part) => part === ".." || part === ".") ||
      !/(^|\/)node_modules$/.test(tree)
    )
      return;
    if (!existsSync(join(store, tree)) || !lstatSync(join(store, tree)).isDirectory()) return;
    trees.push(tree);
  }
  return { store: realpathSync(store), trees };
}

/**
 * A generation is named by its dependency key, never by a random id. Builds resolve dependencies
 * through the store's real path, and the apps framework's output carries it, so a random name made
 * every fresh store build different bytes and redeployed Workers whose source had not changed
 * (#1811). One key always installs one set of packages, so one name per key loses nothing.
 */
export const generationName = (key: string) => digest(`dependency-generation:${key}`).slice(0, 32);

function publishedGeneration(entry: string, key: string) {
  const pointer = join(entry, "current");
  try {
    const target = readlinkSync(pointer);
    const store = realpathSync(join(entry, target));
    if (!store.startsWith(`${realpathSync(join(entry, "generations"))}${sep}`)) return;
    return readyGeneration(store, key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((error as NodeJS.ErrnoException).code === "EINVAL") return;
    throw error;
  }
}

/** Point the key at its named generation when that is ready but no longer published. */
function adoptGeneration(entry: string, key: string) {
  const store = join(entry, "generations", generationName(key));
  if (!existsSync(store)) return;
  const ready = readyGeneration(store, key);
  if (!ready) return;
  const pointer = join(entry, `.current-${randomUUID()}`);
  symlinkSync(join("generations", generationName(key)), pointer);
  renameSync(pointer, join(entry, "current"));
  return ready;
}

/**
 * The generation a prepare uses. A published one under the key's name is used as it is; a ready one
 * under that name is adopted. A published store under any other name (a random one prepared before
 * #1811, or a fallback beside a broken named one) is kept only while that name is still taken, or
 * when the prepare may not install; once the name is free, the key installs under it.
 */
function keyedGeneration(entry: string, key: string, cacheHitOnly: boolean) {
  const published = publishedGeneration(entry, key);
  if (published && basename(published.store) === generationName(key)) return published;
  const adopted = adoptGeneration(entry, key);
  if (adopted) return adopted;
  if (cacheHitOnly || existsSync(join(entry, "generations", generationName(key)))) return published;
  return undefined;
}

function readonlyTree(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) readonlyTree(child);
    else chmodSync(child, lstatSync(child).mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(path, 0o555);
}

function writablePrivateDirectories(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry?.isDirectory()) return;
  // Copied directory modes are immutable too; package and workspace links must stay untouched.
  if (!(entry.mode & 0o200)) chmodSync(path, (entry.mode & 0o7777) | 0o200);
  for (const child of readdirSync(path, { withFileTypes: true }))
    if (child.isDirectory()) writablePrivateDirectories(join(path, child.name));
}

function removePrivateTree(path: string) {
  writablePrivateDirectories(path);
  rmSync(path, { recursive: true, force: true });
}

async function prepareDependencyGeneration(root: string, pin: string, cacheHitOnly: boolean) {
  const omitReleaseDownloads = process.env.BASALT_CI_OMIT_RELEASE_DOWNLOADS === "true";
  const { files, key } = dependencyIdentity(root, pin, omitReleaseDownloads);
  const entry = join(upstreamCache(), "prepared", pin, key);
  const prepared = await withCacheLock(`${entry}.lock`, async () => {
    let generation = await withDependencyStoreLock(() => {
      const found = keyedGeneration(entry, key, cacheHitOnly);
      if (found) rememberDependencyConsumer(root, found.store, true);
      return found;
    });
    let attempt: string | undefined;
    try {
      if (generation === undefined) {
        if (cacheHitOnly) throw new Error(`Refusing a new dependency generation for key ${key}`);
        attempt = await createInstallAttempt(entry);
        for (const file of files) {
          mkdirSync(dirname(join(attempt, file)), { recursive: true });
          cpSync(join(root, file), join(attempt, file));
        }
        // Check uses system Git; only upstream release packaging needs these bundled runtimes.
        if (omitReleaseDownloads) {
          omitReleaseLifecycles(attempt);
          console.log(
            "Check dependency cache miss: release-only lifecycles omitted; GitHub release hosts blocked",
          );
        }
        await installPrivateAttempt(attempt);
        const trees = moduleTrees(attempt);
        const packages = realpathSync(join(attempt, "node_modules/.bun"));
        // Package links inside Bun's store must not resolve into the canonical workspace's source.
        const check = (path: string) => {
          for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name);
            if (entry.isDirectory()) check(child);
            if (entry.isSymbolicLink() && !realpathSync(child).startsWith(`${packages}/`))
              throw new Error(
                "Bun package store contains a workspace dependency; cannot share it safely",
              );
          }
        };
        for (const entry of readdirSync(packages, { withFileTypes: true }))
          if (entry.isDirectory() && entry.name !== "node_modules")
            check(join(packages, entry.name));
        readonlyTree(packages);
        const marker = join(attempt, `.ready-${randomUUID()}.json`);
        writeFileSync(marker, JSON.stringify({ key, trees }), { flag: "wx", mode: 0o600 });
        renameSync(marker, join(attempt, "ready.json"));
        const completed = attempt;
        generation = await withDependencyStoreLock(() => {
          const named = join(entry, "generations", generationName(key));
          // A ready generation under the key's name was adopted above, so one there now is broken,
          // and a checkout may still run from it. The new one takes another name until the
          // collector frees the key's own; the first prepare after that installs under it.
          const id = existsSync(named) ? `${basename(named)}-${randomUUID()}` : basename(named);
          const store = join(entry, "generations", id);
          mkdirSync(dirname(store), { recursive: true });
          renameSync(completed, store);
          const pointer = join(entry, `.current-${randomUUID()}`);
          symlinkSync(join("generations", id), pointer);
          renameSync(pointer, join(entry, "current"));
          const published = { store: realpathSync(store), trees };
          rememberDependencyConsumer(root, published.store, true);
          return published;
        });
      }
      const selected = generation;
      return await withDependencyStoreLock(() => {
        const { store, trees } = selected;
        let links: ReturnType<typeof linkFingerprint>;
        for (const tree of trees) {
          const source = join(store, tree),
            destination = join(root, tree);
          const temporary = `${destination}.basalt-new`;
          removePrivateTree(temporary);
          mkdirSync(dirname(destination), { recursive: true });
          cpSync(source, temporary, {
            recursive: true,
            verbatimSymlinks: true,
            filter: (file) => relative(source, file) !== ".bun",
          });
          if (tree === "node_modules") {
            const bun = join(store, "node_modules/.bun");
            mkdirSync(join(temporary, ".bun"));
            for (const entry of readdirSync(bun)) {
              const target = join(temporary, ".bun", entry);
              if (entry === "node_modules")
                cpSync(join(bun, entry), target, { recursive: true, verbatimSymlinks: true });
              else symlinkSync(join(bun, entry), target, "dir");
            }
          }
          writablePrivateDirectories(temporary);
          // Taken before the rename, which keeps the directory's inode and mtime: links anyone swaps
          // in afterwards, even mid-install, no longer match what the marker vouches for.
          if (tree === "node_modules") links = linkFingerprint(join(temporary, ".bun"));
          // Dependencies contain relative workspace links; the copied link layout keeps source worktree-local.
          removePrivateTree(destination);
          renameSync(temporary, destination);
        }
        // The marker vouches for these exact links, so collection can skip reading them one by one.
        atomicStoreJson(join(root, ".basalt-dependencies.json"), {
          key,
          store,
          ...(links && { links }),
        });
        rememberDependencyConsumer(root, store, false);
        collectDependencyStore(pin);
        return selected;
      });
    } catch (error) {
      if (attempt) await abandonInstallAttempt(attempt);
      throw error;
    }
  });
  return { key, store: prepared.store };
}

export function installUpstreamDependencies(root: string, pin: string, cacheHitOnly = false) {
  root = realpathSync(root);
  // Two different dependency keys must not replace one checkout's references concurrently.
  return withCacheLock(join(upstreamCache(), "consumers", `${digest(root)}.lock`), () =>
    prepareDependencyGeneration(root, pin, cacheHitOnly),
  );
}
