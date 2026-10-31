import { build } from "esbuild";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const output = join(root, ".dist");
await mkdir(output, { recursive: true });
const common = { absWorkingDir: root, bundle: true, sourcemap: true, logLevel: "info" };
await build({
  ...common,
  entryPoints: ["main.ts"],
  outfile: join(output, "main.cjs"),
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron", "@napi-rs/keyring"],
});
await build({
  ...common,
  entryPoints: ["preload.ts"],
  outfile: join(output, "preload.cjs"),
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});
await build({
  ...common,
  entryPoints: ["../cli/main.mjs"],
  outfile: join(output, "connection.mjs"),
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@napi-rs/keyring", "bufferutil", "utf-8-validate"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
await build({
  ...common,
  entryPoints: ["ui.tsx"],
  outfile: join(output, "ui.js"),
  platform: "browser",
  format: "esm",
  target: "chrome144",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile(join(root, "style.css"), join(output, "style.css"));
await copyFile(join(root, "../../public/brand/logo.png"), join(output, "icon.png"));
await writeFile(
  join(output, "index.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>Signalbox Client</title><link rel="stylesheet" href="./style.css"></head><body><div id="root"></div><script type="module" src="./ui.js"></script></body></html>\n',
);
