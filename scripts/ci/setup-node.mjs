import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerified } from "./verified-download.mjs";

const pins = JSON.parse(readFileSync(new URL("./node-assets.json", import.meta.url), "utf8"));

export function nodeAsset(version, platform = `${process.platform}-${process.arch}`) {
  if (version !== pins.version || !pins.assets[platform])
    throw new Error(`No checksum-pinned Node ${version} for ${platform}`);
  const asset = pins.assets[platform];
  return {
    url: `https://nodejs.org/dist/v${version}/${asset.file}`,
    integrity: "sha256-" + Buffer.from(asset.sha256, "hex").toString("base64"),
    key: `node-dist-v1-${version}-${platform}-${asset.sha256}`,
    file: asset.file,
  };
}

export function installNode(version, root) {
  const asset = nodeAsset(version);
  const archive = join(root, asset.file);
  downloadVerified(asset.url, asset.integrity, archive);
  const distribution = join(root, "distribution");
  mkdirSync(distribution, { recursive: true });
  execFileSync("tar", ["-xf", archive, "--strip-components=1", "-C", distribution]);
  const bin = process.platform === "win32" ? distribution : join(distribution, "bin");
  const actual = execFileSync(
    join(bin, process.platform === "win32" ? "node.exe" : "node"),
    ["--version"],
    { encoding: "utf8" },
  ).trim();
  if (actual !== `v${version}`) throw new Error(`Expected Node ${version}, got ${actual}`);
  return bin;
}

function main(mode, version) {
  if (!version || !process.env.RUNNER_TEMP)
    throw new Error("Expected Node version and runner temp directory");
  const asset = nodeAsset(version);
  const root = join(process.env.RUNNER_TEMP, "basalt-node", version);
  if (mode === "identify" && process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `key=${asset.key}\narchive=${join(root, asset.file)}\n`,
    );
  else if (mode === "install") {
    const bin = installNode(version, root);
    if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, bin + "\n");
    console.log(`Node ${version} installed from its verified official archive`);
  } else throw new Error("Expected identify or install");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2], process.argv[3]);
