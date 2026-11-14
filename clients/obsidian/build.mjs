// Bundles the plugin into one CommonJS main.js that runs on desktop and mobile Obsidian.
// The output is exactly what Obsidian's installers download: main.js, manifest.json, styles.css.
// Usage: node build.mjs [--esbuild <path>] [--outdir <dir>]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
// In the repo this lives at clients/obsidian, next to the prepared upstream toolchain.
const esbuild = resolve(
  option("--esbuild", join(here, "../../.upstream/node_modules/.bin/esbuild")),
);
const outdir = resolve(option("--outdir", join(here, "dist")));
if (!existsSync(esbuild)) {
  console.error(`esbuild not found at ${esbuild}. Run the repo prepare step or pass --esbuild.`);
  process.exit(1);
}
mkdirSync(outdir, { recursive: true });
// Only the plugin's own files are replaced: an outdir inside a vault also holds its sync state.
const shipped = ["main.js", "manifest.json", "styles.css"];
for (const file of [...shipped, "desktop-reader.cjs"]) rmSync(join(outdir, file), { force: true });
// The desktop reader is bundled behind its lazy require, and the device name asks the computer for
// its name on desktop only; only these built-ins stay external.
const desktopBuiltins = ["node:fs/promises", "node:path", "node:os"];

const result = spawnSync(
  esbuild,
  [
    join(here, "plugin", "main.ts"),
    "--bundle",
    "--format=cjs",
    // Browser platform: a Node built-in import fails the build instead of breaking on phones.
    "--platform=browser",
    "--target=es2022",
    "--external:obsidian",
    ...desktopBuiltins.map((name) => `--external:${name}`),
    "--legal-comments=none",
    "--log-level=warning",
    `--outfile=${join(outdir, "main.js")}`,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const bundle = readFileSync(join(outdir, "main.js"), "utf8");
const requires = [...bundle.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/gu)].map(
  (match) => match[1],
);
const forbidden = [
  ...requires.filter((name) => name !== "obsidian" && !desktopBuiltins.includes(name)),
  ...[/\bfrom\s*["']node:/u, /["']electron["']/u, /\bprocess\.versions\b/u]
    .filter((pattern) => pattern.test(bundle))
    .map(String),
];
if (forbidden.length) {
  console.error(
    `main.js must only import "obsidian" and the desktop-only built-ins; found: ${[...new Set(forbidden)].join(", ")}`,
  );
  process.exit(1);
}
// Load it the way a phone does: "obsidian" resolves and every Node built-in throws. Passing
// proves the desktop-only built-ins are only required on desktop, not when the plugin loads.
const obsidian = new Proxy({}, { get: () => class {} });
const mobile = { exports: {} };
new Function("require", "module", "exports", bundle)(
  (name) => {
    if (name === "obsidian") return obsidian;
    throw new Error(`main.js required "${name}" while loading, which breaks on phones`);
  },
  mobile,
  mobile.exports,
);
if (typeof mobile.exports.default !== "function") {
  console.error("main.js must export the plugin class as its default export");
  process.exit(1);
}
for (const file of ["manifest.json", "styles.css"])
  copyFileSync(join(here, file), join(outdir, file));
const missing = shipped.filter((file) => !existsSync(join(outdir, file)));
if (missing.length) {
  console.error(`The plugin must ship as ${shipped.join(", ")}; missing ${missing.join(", ")}`);
  process.exit(1);
}
console.log(
  `Built ${join(outdir, "main.js")} (${bundle.length.toLocaleString("en-US")} bytes; Obsidian import and lazily required desktop-only built-ins)`,
);
