import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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

// electron-builder hands @electron/get no checksums, so every package run fetched Electron's
// SHASUMS256.txt from the mirror, cache bypassed, and one stalled request failed the job. With the
// locked checksums it verifies the zip offline. They pass through only when electronDownload is in
// @electron/get's shape, which unsafelyDisableChecksums marks; mirrorOptions would mark it too, but
// ElectronFramework then keeps only the mirror and drops the checksums.
export function electronBuilderConfig(desktop: NodeJS.Require) {
  return {
    ...desktop("./package.json").build,
    electronDownload: {
      unsafelyDisableChecksums: false,
      checksums: desktop("electron/checksums.json") as Record<string, string>,
    },
  };
}

async function main(mode: string | undefined, output: string | undefined) {
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
  } else if (mode === "builder-config") {
    // An explicit --config replaces package.json's build, so the file carries all of it.
    if (!output) throw new Error("Expected the electron-builder config path");
    writeFileSync(output, JSON.stringify(electronBuilderConfig(require), null, 2) + "\n");
    console.log(`electron-builder verifies Electron against the locked checksums: ${output}`);
  } else throw new Error("Expected key, warm or builder-config");
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv[2], process.argv[3]);
