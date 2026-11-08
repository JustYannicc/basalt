import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { digest } from "../upstream-cache.ts";

export function desktopAssetKey(lock: string, platform: string) {
  const packages = ["electron", "electron-builder", "app-builder-lib", "builder-util"];
  const identities = packages.map((name) => {
    const match = new RegExp(`^    "${name}": \\["(${name}@[^"\\s]+)"`, "m").exec(lock);
    if (!match) throw new Error(`Release asset cache requires a locked ${name} version`);
    return match[1]!;
  });
  return `desktop-release-assets-v1-${platform}-${digest(JSON.stringify(identities))}`;
}

async function main(mode: string | undefined) {
  const require = createRequire(new URL("../../clients/desktop/package.json", import.meta.url));
  if (mode === "key") {
    const key = desktopAssetKey(
      readFileSync(new URL("../../clients/desktop/bun.lock", import.meta.url), "utf8"),
      `${process.platform}-${process.arch}`,
    );
    if (!process.env.GITHUB_OUTPUT) throw new Error("Expected GitHub action output path");
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
    console.log(`Desktop release assets: ${key}`);
  } else if (mode === "warm") {
    const electron = createRequire(require.resolve("electron/package.json"));
    const builder = createRequire(require.resolve("electron-builder/package.json"));
    const appBuilder = createRequire(builder.resolve("app-builder-lib/package.json"));
    const { downloadArtifact } = electron("@electron/get");
    await downloadArtifact({
      version: require("electron/package.json").version,
      artifactName: "electron",
      platform: process.platform,
      arch: process.arch,
      cacheRoot: process.env.ELECTRON_CACHE,
      checksums: require("electron/checksums.json"),
    });
    const { getPath7za } = appBuilder("./out/toolsets/7zip.js");
    const { getIconsToolsetPath } = appBuilder("./out/toolsets/icons.js");
    await getPath7za();
    await getIconsToolsetPath();
    if (process.platform === "linux") {
      const { getFpmPath, getAppImageTools } = appBuilder("./out/toolsets/linux.js");
      const { Arch } = appBuilder("builder-util");
      const manifest = require("./package.json");
      await getFpmPath();
      await getAppImageTools(manifest.build.toolsets?.appimage ?? "0.0.0", Arch[process.arch]);
    }
    console.log("Desktop release downloads are cached and checksum-verified");
  } else throw new Error("Expected key or warm");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2]);
