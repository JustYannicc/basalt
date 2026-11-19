import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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

/** The cached Electron zip whose bytes match the checksum pinned in the locked electron package. */
export function verifiedElectronZip(cache: string, name: string, sha256: string) {
  return readdirSync(cache, { recursive: true, encoding: "utf8" })
    .filter((path) => basename(path) === name)
    .map((path) => join(cache, path))
    .find((path) => createHash("sha256").update(readFileSync(path)).digest("hex") === sha256);
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
  } else if (mode === "dist") {
    // electron-builder hands @electron/get no checksums, so every package run fetches Electron's
    // SHASUMS256.txt from the mirror with the cache bypassed, and a stalled mirror fails the job after
    // ten minutes. Packaging from this verified zip makes no request at all.
    const version: string = require("electron/package.json").version;
    const checksums: Record<string, string> = require("electron/checksums.json");
    const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
    const sha256 = checksums[name];
    if (!sha256) throw new Error("The locked electron package pins no checksum for " + name);
    if (!process.env.ELECTRON_CACHE || !process.env.GITHUB_ENV)
      throw new Error("Expected the desktop download cache and GitHub environment file");
    let zip = verifiedElectronZip(process.env.ELECTRON_CACHE, name, sha256);
    if (!zip) {
      const electron = createRequire(require.resolve("electron/package.json"));
      const { downloadArtifact } = electron("@electron/get");
      zip = String(
        await downloadArtifact({
          version,
          artifactName: "electron",
          platform: process.platform,
          arch: process.arch,
          cacheRoot: process.env.ELECTRON_CACHE,
          checksums,
          // A stalled mirror costs two minutes per try instead of ten.
          downloadOptions: { timeout: { request: 120_000 }, retry: { limit: 2 } },
        }),
      );
    }
    appendFileSync(process.env.GITHUB_ENV, `ELECTRON_DIST_ZIP=${zip}\n`);
    console.log(`Packaging uses the checksum-verified ${name}`);
  } else throw new Error("Expected key, warm or dist");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2]);
