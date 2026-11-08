import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { digest } from "./upstream-cache.ts";

export const preparedBunVersion = "1.4.2";
// Bun's native clonefile backend shares APFS blocks without sharing mutable inodes.
export const dependencyInstallBackend = process.platform === "darwin" ? "clonefile" : "copyfile";

export function requirePreparedBun() {
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.status !== 0 || bun.stdout.trim() !== preparedBunVersion)
    throw new Error(
      `Dependency preparation requires Bun ${preparedBunVersion}; use the pinned toolchain before retrying.`,
    );
  return preparedBunVersion;
}

export function dependencyInputs(root: string) {
  const files = new Set(["bun.lock", "bunfig.toml", "package.json"]);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        [
          "node_modules",
          ".git",
          ".local",
          ".alchemy",
          ".generated",
          "dist",
          ".blume",
          ".cache",
          ".turbo",
        ].includes(entry.name)
      )
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

export function dependencyIdentity(root: string, pin: string, omitReleaseDownloads = false) {
  const files = dependencyInputs(root);
  const key = digest(
    JSON.stringify({
      format: 3,
      // Both backends isolate inodes, so existing format-3 generations remain compatible.
      backend: "copyfile",
      pin,
      bun: requirePreparedBun(),
      platform: process.platform,
      arch: process.arch,
      ...(omitReleaseDownloads ? { releaseDownloads: "omitted-v1" } : {}),
      inputs: files.map((path) => [path, digest(readFileSync(join(root, path), "utf8"))]),
    }),
  );
  return { files, key };
}
