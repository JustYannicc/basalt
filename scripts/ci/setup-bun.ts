import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerified } from "./verified-download.ts";

export function bunAsset(version: string, platform = `${process.platform}-${process.arch}`) {
  const versions: Record<string, Record<string, { url: string; integrity: string }>> = JSON.parse(
    readFileSync(new URL("./bun-assets.json", import.meta.url), "utf8"),
  );
  const asset = versions[version]?.[platform];
  if (!asset) throw new Error(`No checksum-pinned Bun ${version} for ${platform}`);
  return { ...asset, key: `bun-npm-v1-${version}-${platform}` };
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
    execFileSync("tar", [
      "-xzf",
      archive,
      "--strip-components=2",
      "-C",
      root,
      `package/bin/${binary}`,
    ]);
    chmodSync(join(root, binary), 0o755);
    const actual = execFileSync(join(root, binary), ["--version"], { encoding: "utf8" }).trim();
    if (actual !== version) throw new Error(`Expected Bun ${version}, got ${actual}`);
    if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, root + "\n");
    console.log(`Bun ${version} installed from its verified npm archive`);
  } else throw new Error("Expected identify or install");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2], process.argv[3]);
