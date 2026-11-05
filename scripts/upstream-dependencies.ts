import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { digest, upstreamCache, withCacheLock } from "./upstream-cache.ts";
import {
  abandonInstallAttempt,
  atomicStoreJson,
  collectDependencyStore,
  createInstallAttempt,
  installPrivateAttempt,
  rememberDependencyConsumer,
  withDependencyStoreLock,
} from "./upstream-store.ts";

function inputs(root: string) {
  const files = new Set(["bun.lock", "bunfig.toml", "package.json"]);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", ".local", ".alchemy", ".generated", "dist"].includes(entry.name))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "package.json") files.add(relative(root, path));
    }
  };
  visit(root);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const patch of Object.values(manifest.patchedDependencies ?? {})) files.add(String(patch));
  return [...files].filter((file) => existsSync(join(root, file))).sort();
}

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

function readonlyTree(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) readonlyTree(child);
    else chmodSync(child, lstatSync(child).mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(path, 0o555);
}

async function prepareDependencyGeneration(root: string, pin: string) {
  const files = inputs(root);
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.status !== 0) throw new Error("Bun is required to prepare dependencies");
  const key = digest(
    JSON.stringify({
      format: 3,
      backend: "copyfile",
      pin,
      bun: bun.stdout.trim(),
      platform: process.platform,
      arch: process.arch,
      inputs: files.map((path) => [path, digest(readFileSync(join(root, path), "utf8"))]),
    }),
  );
  const entry = join(upstreamCache(), "prepared", pin, key);
  const prepared = await withCacheLock(`${entry}.lock`, async () => {
    let generation = await withDependencyStoreLock(() => {
      const found = publishedGeneration(entry, key);
      if (found) rememberDependencyConsumer(root, found.store, true);
      return found;
    });
    let attempt: string | undefined;
    try {
      if (generation === undefined) {
        const id = randomUUID();
        attempt = await createInstallAttempt(entry);
        for (const file of files) {
          mkdirSync(dirname(join(attempt, file)), { recursive: true });
          cpSync(join(root, file), join(attempt, file));
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
        const marker = join(attempt, `.ready-${id}.json`);
        writeFileSync(marker, JSON.stringify({ key, trees }), { flag: "wx", mode: 0o600 });
        renameSync(marker, join(attempt, "ready.json"));
        const completed = attempt;
        generation = await withDependencyStoreLock(() => {
          const store = join(entry, "generations", id);
          mkdirSync(dirname(store), { recursive: true });
          renameSync(completed, store);
          const pointer = join(entry, `.current-${id}`);
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
        for (const tree of trees) {
          const source = join(store, tree),
            destination = join(root, tree);
          const temporary = `${destination}.basalt-new`;
          rmSync(temporary, { recursive: true, force: true });
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
          // Dependencies contain relative workspace links; the copied link layout keeps source worktree-local.
          rmSync(destination, { recursive: true, force: true });
          renameSync(temporary, destination);
        }
        atomicStoreJson(join(root, ".basalt-dependencies.json"), { key, store });
        rememberDependencyConsumer(root, store, false);
        collectDependencyStore();
        return selected;
      });
    } catch (error) {
      if (attempt) await abandonInstallAttempt(attempt);
      throw error;
    }
  });
  return { key, store: prepared.store };
}

export function installUpstreamDependencies(root: string, pin: string) {
  root = realpathSync(root);
  // Two different dependency keys must not replace one checkout's references concurrently.
  return withCacheLock(join(upstreamCache(), "consumers", `${digest(root)}.lock`), () =>
    prepareDependencyGeneration(root, pin),
  );
}
