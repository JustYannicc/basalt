import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareUpstreamCheckout } from "../upstream-cache.ts";
import { readPatchManifest } from "../releases/patches.ts";
import { downloadVerified, verifyArchive } from "./verified-download.mjs";
import { omitReleaseLifecycles } from "./dependency-lifecycles.ts";

export function workerdAsset(upstream: string) {
  const pin = JSON.parse(
    readFileSync(join(upstream, "apps/hosted/self-host/workerd.json"), "utf8"),
  );
  const asset = pin.assets["linux-64"];
  return {
    name: `${pin.repository} ${pin.release}/${asset.name}`,
    url: `https://github.com/${pin.repository}/releases/download/${pin.release}/${asset.name}`,
    integrity: "sha256-" + Buffer.from(asset.sha256, "hex").toString("base64"),
    key: `workerd-v1-${pin.release}-linux-64-${asset.sha256}`,
    sha256: asset.sha256 as string,
  };
}

export function prepareImageContext(upstream: string, destination: string, archive: string) {
  verifyArchive(archive, workerdAsset(upstream).integrity);
  cpSync(upstream, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) =>
      !relative(upstream, path)
        .split(sep)
        .some(
          (part) =>
            [
              "node_modules",
              "dist",
              ".git",
              ".reference",
              ".local",
              ".alchemy",
              ".wrangler",
            ].includes(part) ||
            part.startsWith(".env") ||
            part.startsWith(".basalt-"),
        ),
  });
  omitReleaseLifecycles(destination);
  const local = join(destination, "apps/hosted/self-host/.ci-workerd/archive.gz");
  mkdirSync(join(local, ".."), { recursive: true });
  cpSync(archive, local);
  const dockerfile = join(destination, "apps/hosted/self-host/Dockerfile");
  const source = readFileSync(dockerfile, "utf8");
  const command = "RUN bun run --cwd apps/hosted/self-host package:runtime";
  if (source.split(command).length !== 2)
    throw new Error("Expected exactly one self-host runtime packaging command");
  writeFileSync(
    dockerfile,
    source.replace(
      command,
      "RUN EXECUTOR_WORKERD_ARCHIVE=/build/apps/hosted/self-host/.ci-workerd/archive.gz bun run --cwd apps/hosted/self-host package:runtime",
    ),
  );
}

async function main(mode: string | undefined) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const upstream = join(root, ".upstream");
  if (!process.env.RUNNER_TEMP) throw new Error("Expected runner temp directory");
  if (!existsSync(join(upstream, ".git")))
    await prepareUpstreamCheckout(
      upstream,
      JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")),
      readPatchManifest(root).patches.map(({ file }) => join(root, "patches", file)),
    );
  const asset = workerdAsset(upstream);
  const archive = join(process.env.RUNNER_TEMP, "basalt-workerd", asset.sha256 + ".gz");
  if (mode === "identify" && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${asset.key}\narchive=${archive}\n`);
  else if (mode === "warm") {
    try {
      downloadVerified(asset.url, asset.integrity, archive);
    } catch (error) {
      const reason = `Cannot warm pinned workerd asset ${asset.name}; SHA-256 ${asset.sha256}. The cold release source is unavailable or failed verification.`;
      console.error(`::error::${reason}`);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, reason + "\n");
      throw error;
    }
  } else if (mode === "verify") {
    verifyArchive(archive, asset.integrity);
    console.log(`Offline workerd archive verified: ${asset.name}`);
  } else if (mode === "image") {
    prepareImageContext(upstream, join(process.env.RUNNER_TEMP, "basalt-upstream-image"), archive);
    console.log(`Isolated image context uses the cached archive for ${asset.name}`);
  } else throw new Error("Expected identify, warm, verify or image");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2]);
