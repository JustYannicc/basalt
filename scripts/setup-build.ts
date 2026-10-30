import { createRequire } from "node:module";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brand } from "../brand.ts";
const require = createRequire(new URL("../.upstream/package.json", import.meta.url));
const { build } = require("esbuild") as typeof import("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(`${root}public/setup`, { recursive: true });
// The setup page moved to Connect; a checkout built before then must not deploy its leftovers.
for (const stale of ["index.html", "main.js"]) rmSync(`${root}public/setup/${stale}`, { force: true });
mkdirSync(`${root}public/share`, { recursive: true });
await build({
  entryPoints: [`${root}src/setup/client.mjs`], outfile: `${root}public/setup/client.mjs`,
  bundle: true, platform: "node", format: "esm", target: "node18", minify: true,
});
const react = `${root}.upstream/playground/demo-apps/live-inbox/node_modules`;
// The root sharing page reuses the pool app's components; its stylesheet keeps the setup path.
const pages = { share: "share-ui.tsx" } as const;
for (const [page, entry] of Object.entries(pages)) await build({
  entryPoints: [`${root}src/setup/${entry}`], outfile: `${root}public/${page}/main.js`,
  bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true, jsx: "automatic",
  alias: { react: `${react}/react`, "react-dom": `${react}/react-dom` },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "product-name", setup(build) {
    build.onLoad({ filter: /apps\/pool\/deployment\.ts$/ }, () => ({ contents: `export const productName=${JSON.stringify(brand.name)};`, loader: "ts" }));
  } }],
});
const styles = await build({
  entryPoints: [`${root}apps/pool/ui/style.css`], outfile: `${root}.generated/setup.css`, write: false,
  bundle: true, alias: { tailwindcss: `${root}.upstream/packages/ui/node_modules/tailwindcss/index.css` },
});
const sdk = createRequire(new URL("../.upstream/packages/sdk/package.json", import.meta.url));
const { compile } = sdk("tailwindcss");
const vite = createRequire(realpathSync(new URL("../.upstream/apps/hosted/web/node_modules/@tailwindcss/vite/package.json", import.meta.url)));
const { Scanner } = vite("@tailwindcss/oxide");
const candidates = new Scanner({ sources: [] }).scanFiles(Object.keys(pages).map((page) => ({ content: readFileSync(`${root}public/${page}/main.js`, "utf8"), extension: "js" })));
const compiler = await compile(styles.outputFiles![0]!.text);
writeFileSync(`${root}public/setup/main.css`, compiler.build(candidates));
const titles = { share: "Share your pool" } as const;
for (const page of Object.keys(pages) as (keyof typeof pages)[])
  writeFileSync(`${root}public/${page}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${titles[page]}</title><link rel="icon" href="${brand.logo}"><link rel="stylesheet" href="/setup/main.css"><body><div id="root"></div><script type="module" src="/${page}/main.js"></script></body></html>`);
