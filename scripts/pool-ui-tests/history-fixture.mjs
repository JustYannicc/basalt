import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, ".upstream/package.json"));
const web = createRequire(join(root, ".upstream/apps/hosted/web/package.json"));
const { chromium } = require("playwright");
const { build, stop } = require("esbuild");

/** Real history UI, with source metadata supplied at its ordinary reader boundary. */
export async function historyFixture() {
  const built = await build({
    stdin: {
      contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {History} from './apps/pool/ui/history.tsx';
import {overviewFixture} from './scripts/pool-ui-tests/overview-fixture.mjs';
const first='2026-11-04T11:28:37.250Z',checked='2026-11-09T08:00:00.000Z';
let times=[first];
window.addSyntheticRequest=()=>{times.push('2026-11-09T08:01:02.000Z')};
const records=()=>times.map((timestamp,i)=>({id:String(i+1).padStart(64,'0'),timestamp,person:null,
 request_id:'synthetic-'+i,provider:'codex',model:'Synthetic model',endpoint:'/v1/responses',api_type:'responses',
 service_tier:null,input_tokens:'100',output_tokens:'10',cache_read_tokens:'0',cache_write_tokens:'0',
 reasoning_tokens:'0',total_tokens:'110',token_quality:'complete',latency_ms:'100',failed:false,
 status_code:200,cost:null,currency:null,cost_basis:'unpriced',attribution:'unknown'}));
const series=async(input)=>{
 const result=overviewFixture(input,{total:{requests:times.length,tokens:{total:110*times.length}},models:[{provider:'codex',model:'Synthetic model'}]}).people;
 result.asOf=checked;
 result.coverage={...result.coverage,firstAt:first,lastAt:times.at(-1),capturedThrough:first};
 return {ok:true,value:result};
};
createRoot(document.getElementById('root')).render(<History series={series}
 publicHistory={async()=>({ok:true,value:{records:records(),next:null}})} directory={[]}
 providers={[{id:'codex',name:'ChatGPT'}]} onBack={()=>{}}/>);`,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    nodePaths: [join(root, ".upstream/apps/hosted/web/node_modules")],
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const javascript = built.outputFiles[0].text;
  const styles = await build({
    entryPoints: [join(root, "apps/pool/ui/style.css")],
    bundle: true,
    write: false,
    outfile: "main.css",
    conditions: ["style"],
    alias: { tailwindcss: join(root, ".upstream/packages/ui/node_modules/tailwindcss/index.css") },
  });
  const { compile } = web("tailwindcss");
  const { Scanner } = createRequire(
    realpathSync(
      join(root, ".upstream/apps/hosted/web/node_modules/@tailwindcss/vite/package.json"),
    ),
  )("@tailwindcss/oxide");
  const candidates = new Scanner({ sources: [] }).scanFiles([
    { content: javascript, extension: "js" },
  ]);
  const stylesheet =
    "@font-face{font-family:Geist;src:url(/font.woff2);font-weight:100 900}" +
    (await compile(styles.outputFiles[0].text)).build(candidates);
  const server = await chromium.launchServer({ headless: true });
  const browser = await chromium.connect(server.wsEndpoint());
  return {
    async page(width) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        colorScheme: "light",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/main.js")
          return route.fulfill({ contentType: "text/javascript", body: javascript });
        if (path === "/main.css")
          return route.fulfill({ contentType: "text/css", body: stylesheet });
        if (path === "/font.woff2")
          return route.fulfill({
            contentType: "font/woff2",
            body: readFileSync(
              join(root, ".upstream/packages/ui/src/implementation/styles/fonts/geist-sans.woff2"),
            ),
          });
        if (path === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/main.css"><div id="root"></div><script type="module" src="/main.js"></script>',
          });
        return route.abort();
      });
      await page.goto("http://history.example.test/");
      await page.getByRole("region", { name: "Request history", exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      return { page, context, errors };
    },
    async close() {
      await browser.close();
      await server.close();
      const child = server.process();
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        "Owned headless browser exited",
      );
      stop();
    },
  };
}
