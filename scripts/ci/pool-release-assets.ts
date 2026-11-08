import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadVerified, verifyArchive } from "./verified-download.mjs";

export const poolCompatibilityCommit = "b35314687e8972f64d7c1c3c73a1492a50fb7bac";
type PoolReleases = {
  format_version: number;
  artifacts: Record<
    "home" | "node",
    {
      repository: string;
      tag: string;
      assets: Record<string, { name: string; sha256: string }>;
    }
  >;
};

export function compatibilityPoolManifest(root: string): PoolReleases {
  return JSON.parse(
    execFileSync("git", ["show", `${poolCompatibilityCommit}:containers/pool/releases.json`], {
      cwd: root,
      encoding: "utf8",
    }),
  );
}

export function poolReleaseAssets(manifest: PoolReleases, architecture = "amd64") {
  if (manifest.format_version !== 1) throw new Error("Unsupported pool release manifest");
  const assets = (["home", "node"] satisfies (keyof PoolReleases["artifacts"])[]).map((role) => {
    const artifact = manifest.artifacts[role];
    const asset = artifact.assets[architecture];
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256))
      throw new Error(`Missing pinned pool ${role} archive for ${architecture}`);
    return {
      name: `${artifact.repository} ${artifact.tag}/${asset.name}`,
      url: `https://github.com/${artifact.repository}/releases/download/${artifact.tag}/${asset.name}`,
      sha256: asset.sha256,
      integrity: "sha256-" + Buffer.from(asset.sha256, "hex").toString("base64"),
    };
  });
  const digest = createHash("sha256")
    .update(JSON.stringify({ architecture, manifest }))
    .digest("hex");
  return { key: `pool-compatibility-archives-v1-${architecture}-${digest}`, assets };
}

export function preparePoolCompatibilityContext(
  root: string,
  context: string,
  cache: string,
  manifest: PoolReleases,
) {
  const assets = poolReleaseAssets(manifest).assets;
  if (
    JSON.stringify(JSON.parse(readFileSync(join(context, "releases.json"), "utf8"))) !==
    JSON.stringify(manifest)
  )
    throw new Error("Pool compatibility context differs from its frozen release pins");
  for (const asset of assets) verifyArchive(join(cache, asset.sha256 + ".tar.gz"), asset.integrity);
  const dockerfile = join(context, "Dockerfile");
  const source = readFileSync(dockerfile, "utf8");
  const command = 'RUN python3 fetch_releases.py --arch "$TARGETARCH" --destination /out';
  if (source.split(command).length !== 2)
    throw new Error("Expected one compatibility release-fetch command");
  const archives = join(context, ".release-archives");
  mkdirSync(archives, { recursive: true });
  for (const asset of assets)
    cpSync(join(cache, asset.sha256 + ".tar.gz"), join(archives, asset.sha256 + ".tar.gz"));
  cpSync(join(root, "containers/pool/fetch_releases.py"), join(context, "fetch_releases.py"));
  writeFileSync(
    dockerfile,
    source.replace(
      command,
      'COPY .release-archives /release-archives\nRUN BASALT_POOL_RELEASE_ARCHIVE_DIR=/release-archives python3 fetch_releases.py --arch "$TARGETARCH" --destination /out',
    ),
  );
}

function main(mode: string | undefined) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  if (!process.env.RUNNER_TEMP) throw new Error("Expected runner temp directory");
  const manifest = compatibilityPoolManifest(root);
  const { key, assets } = poolReleaseAssets(manifest);
  const cache = join(process.env.RUNNER_TEMP, "basalt-pool-release-assets");
  if (mode === "identify" && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\npath=${cache}\n`);
  else if (mode === "warm" || mode === "verify") {
    const failures: string[] = [];
    for (const asset of assets) {
      try {
        const archive = join(cache, asset.sha256 + ".tar.gz");
        if (mode === "warm") downloadVerified(asset.url, asset.integrity, archive);
        else verifyArchive(archive, asset.integrity);
      } catch {
        const reason = `Cannot ${mode === "warm" ? "warm" : "use cached"} pool compatibility archive ${asset.name}; SHA-256 ${asset.sha256}. Source unavailable or archive verification failed.`;
        console.error(`::error::${reason}`);
        failures.push(reason);
      }
    }
    if (failures.length) {
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, failures.join("\n") + "\n");
      throw new Error("Pinned pool compatibility archives are unavailable");
    }
  } else if (mode === "context" && process.argv[3]) {
    preparePoolCompatibilityContext(root, process.argv[3], cache, manifest);
    console.log("Compatibility image build consumes verified archives offline");
  } else throw new Error("Expected identify, warm, verify or context with its path");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2]);
