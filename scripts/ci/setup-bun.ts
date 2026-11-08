import { appendFileSync, chmodSync, linkSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveTar, downloadVerified } from "./verified-download.mjs";

export function bunAsset(version: string, platform = `${process.platform}-${process.arch}`) {
  const versions: Record<string, Record<string, { url: string; integrity: string }>> = JSON.parse(
    readFileSync(new URL("./bun-assets.json", import.meta.url), "utf8"),
  );
  const asset = versions[version]?.[platform];
  if (!asset) throw new Error(`No checksum-pinned Bun ${version} for ${platform}`);
  return { ...asset, key: `bun-npm-v1-${version}-${platform}` };
}

export function bunEntrypoints(root: string, platform = process.platform) {
  const bun = join(root, platform === "win32" ? "bun.exe" : "bun");
  const bunx = join(root, platform === "win32" ? "bunx.exe" : "bunx");
  rmSync(bunx, { force: true });
  linkSync(bun, bunx);
  return { bun, bunx };
}

function main(mode: string | undefined, version: string | undefined) {
  if (!version || !process.env.RUNNER_TEMP)
    throw new Error("Expected Bun version and runner temp directory");
  const asset = bunAsset(version);
  const root = join(process.env.RUNNER_TEMP, "basalt-bun", version);
  const archive = join(root, "bun.tgz");
  if (mode === "identify") {
    if (!process.env.GITHUB_OUTPUT) throw new Error("Expected action output path");
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${asset.key}\narchive=${archive}\n`);
  } else if (mode === "install") {
    downloadVerified(asset.url, asset.integrity, archive);
    mkdirSync(root, { recursive: true });
    const binary = process.platform === "win32" ? "bun.exe" : "bun";
    execFileSync(archiveTar(), [
      "-xzf",
      archive,
      "--strip-components=2",
      "-C",
      root,
      `package/bin/${binary}`,
    ]);
    chmodSync(join(root, binary), 0o755);
    const entrypoints = bunEntrypoints(root);
    const actual = execFileSync(entrypoints.bun, ["--version"], { encoding: "utf8" }).trim();
    if (actual !== version) throw new Error(`Expected Bun ${version}, got ${actual}`);
    const help = spawnSync(entrypoints.bunx, ["--help"], { encoding: "utf8" });
    if (help.error) throw help.error;
    // bunx returns 1 for its usage page, including --help.
    if (![0, 1].includes(help.status ?? -1) || !(help.stdout + help.stderr).includes("Usage: bunx"))
      throw new Error("The installed bunx entry point did not print its usage");
    if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, root + "\n");
    console.log(`Bun ${version} and bunx installed from the verified npm archive`);
  } else throw new Error("Expected identify or install");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2], process.argv[3]);
