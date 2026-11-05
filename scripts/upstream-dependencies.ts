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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { digest, upstreamCache, withCacheLock } from "./upstream-cache.ts";
import { run } from "./process.ts";

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

function removeIncompleteStore(path: string) {
  if (!existsSync(path)) return;
  const writable = (directory: string) => {
    chmodSync(directory, 0o755);
    for (const entry of readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory()) writable(join(directory, entry.name));
  };
  writable(path);
  rmSync(path, { recursive: true, force: true });
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

export async function installUpstreamDependencies(root: string, pin: string) {
  const files = inputs(root);
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.status !== 0) throw new Error("Bun is required to prepare dependencies");
  const key = digest(
    JSON.stringify({
      pin,
      bun: bun.stdout.trim(),
      platform: process.platform,
      arch: process.arch,
      inputs: files.map((path) => [path, digest(readFileSync(join(root, path), "utf8"))]),
    }),
  );
  const store = join(upstreamCache(), "prepared", pin, key);
  await withCacheLock(`${store}.lock`, () => {
    if (!existsSync(join(store, "ready.json"))) {
      // A crashed installer never publishes ready.json; only its private incomplete directory is rebuilt.
      removeIncompleteStore(store);
      mkdirSync(store, { recursive: true });
      for (const file of files) {
        mkdirSync(dirname(join(store, file)), { recursive: true });
        cpSync(join(root, file), join(store, file));
      }
      run("bun", ["install", "--frozen-lockfile"], store);
      const trees = moduleTrees(store);
      const packages = realpathSync(join(store, "node_modules/.bun"));
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
        if (entry.isDirectory() && entry.name !== "node_modules") check(join(packages, entry.name));
      readonlyTree(packages);
      writeFileSync(join(store, "ready.json"), JSON.stringify({ key, trees }));
    }
    const { trees } = JSON.parse(readFileSync(join(store, "ready.json"), "utf8")) as {
      trees: string[];
    };
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
  });
  writeFileSync(join(root, ".basalt-dependencies.json"), JSON.stringify({ key, store }));
  return { key, store };
}
