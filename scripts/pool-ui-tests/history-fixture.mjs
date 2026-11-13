import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { historyBackend } from "./history-backend.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, ".upstream/package.json"));
const web = createRequire(join(root, ".upstream/apps/hosted/web/package.json"));
const { chromium } = require("playwright");
const { build, stop } = require("esbuild");

/** Real history UI, with source metadata supplied at its ordinary reader boundary. */
export async function historyFixture({ sourceRef } = {}) {
  const built = await build({
    plugins: sourceRef
      ? [
          {
            name: "baseline-history-readers",
            setup(build) {
              build.onLoad({ filter: /\/apps\/pool\/ui\/api\.ts$/ }, () => ({
                contents: execFileSync("git", ["show", `${sourceRef}:apps/pool/ui/api.ts`], {
                  cwd: root,
                  encoding: "utf8",
                }),
                loader: "ts",
                resolveDir: join(root, "apps/pool/ui"),
              }));
            },
          },
        ]
      : [],
    stdin: {
      contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {History} from './apps/pool/ui/history.tsx';
import {createAppClient} from 'apps/client';
window.historyShown=true;
window.addEventListener('message',event=>{
 if(event.source===window.parent && event.data?.type==='executor:app-active')
   window.historyShown=event.data.active;
});
window.fixtureActive=createAppClient().isActive;
window.historyHttpReads=[];
const httpFetch=window.fetch.bind(window);
window.fetch=(input,init)=>{
 const path=new URL(input instanceof Request?input.url:String(input),location.href).pathname;
 window.historyHttpReads.push({path,active:window.historyShown && document.visibilityState==='visible'});
 return httpFetch(input,init);
};
const {pool}=await import('./apps/pool/ui/api.ts');
window.readHiddenHistory=()=>pool.publicHistory({from:'2026-11-04T00:00:00Z',to:'2026-11-05T00:00:00Z'});
window.hideTab=()=>{
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
 document.dispatchEvent(new Event('visibilitychange'));
};
window.showTab=()=>{
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 document.dispatchEvent(new Event('visibilitychange'));
};
createRoot(document.getElementById('root')).render(<History changes={pool.changes} series={pool.series}
 publicHistory={pool.publicHistory} directory={[]}
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
  const backend = await historyBackend();
  const server = await chromium.launchServer({ headless: true }).catch(async (error) => {
    await backend.close();
    throw error;
  });
  const browser = await chromium.connect(server.wsEndpoint()).catch(async (error) => {
    await server.close();
    await backend.close();
    throw error;
  });
  return {
    requests: backend.requests,
    waitFor: backend.waitFor,
    hold: backend.hold,
    release: backend.release,
    async page(width) {
      backend.reset();
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
        if (path === "/fixture-add") {
          backend.add();
          return route.fulfill({ status: 204 });
        }
        if (path.startsWith("/_executor/")) return route.continue();
        if (path === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><iframe title="Pool" src="/history" style="width:100%;height:1000px;border:0"></iframe>',
          });
        if (path === "/history")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/main.css"><script type="application/json" id="executor-context">{"version":"fixture"}</script><div id="root"></div><script type="module" src="/main.js"></script>',
          });
        return route.abort();
      });
      await page.goto(backend.origin);
      const host = page;
      const frame = page.frames().find((frame) => frame.url().endsWith("/history"));
      assert.ok(frame);
      const active = async (value) => {
        await host.evaluate((value) => {
          document
            .querySelector("iframe")
            .contentWindow.postMessage({ type: "executor:app-active", active: value }, "*");
        }, value);
        await frame.waitForFunction((value) => window.fixtureActive() === value, value);
      };
      await frame.getByRole("region", { name: "Request history", exact: true }).waitFor();
      await frame.evaluate(() => document.fonts.ready);
      await frame.evaluate(() => {
        window.addSyntheticRequest = () => fetch("/fixture-add");
      });
      return { page: frame, host, active, context, errors };
    },
    async close() {
      await browser.close();
      await server.close();
      const child = server.process();
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        "Owned headless browser exited",
      );
      await backend.close();
      stop();
    },
  };
}
