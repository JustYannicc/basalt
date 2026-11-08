// Bundles the plugin into one CommonJS main.js that runs on desktop and mobile Obsidian.
// Usage: node build.mjs [--esbuild <path>] [--outdir <dir>]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
    "--external:./desktop-reader.cjs",
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
  ...requires.filter((name) => name !== "obsidian" && name !== "./desktop-reader.cjs"),
  ...[/\bfrom\s*["']node:/u, /["']electron["']/u, /\bprocess\.versions\b/u]
    .filter((pattern) => pattern.test(bundle))
    .map(String),
];
if (forbidden.length) {
  console.error(
    `main.js must only import "obsidian"; found: ${[...new Set(forbidden)].join(", ")}`,
  );
  process.exit(1);
}
for (const file of ["manifest.json", "styles.css"])
  copyFileSync(join(here, file), join(outdir, file));
copyFileSync(join(here, "plugin/desktop-reader.cjs"), join(outdir, "desktop-reader.cjs"));
console.log(
  `Built ${join(outdir, "main.js")} (${bundle.length.toLocaleString("en-US")} bytes; Obsidian import and guarded desktop reader)`,
);
