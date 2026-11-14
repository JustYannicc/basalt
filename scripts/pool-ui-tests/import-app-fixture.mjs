import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { capacityFixture } from "./overview-fixture.mjs";
import { summaryReply } from "../../e2e/pool-overview-usage.mjs";
import { handleSelfUsageImport } from "../../src/pool/model-history/self-import-http.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { bundlePoolApp } from "../pool-app-bundle.ts";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, ".upstream/package.json"));
export const { chromium } = require("playwright");
const usage = {
  scope: "pool",
  from: "2026-01-01T00:00:00Z",
  to: "2026-12-01T00:00:00Z",
  total: { requests: 0, cost: 0, unpriced: 0, tokens: { total: 0 } },
  models: [],
  days: [],
  accounts: [],
  cap: null,
  readAt: null,
};

/** The real pool app runs through apps/host; only unrelated pool readings are synthetic. */
export async function importAppFixture(connectionString) {
  const directory = mkdtempSync(join(tmpdir(), "pool-import-ui-"));
  const signingKey = "ab".repeat(32),
    owner = "fixture-import-owner";
  const token = await signPoolToken(signingKey, {
    pool: "fixture-ui-pool",
    owner,
    organization: "fixture-organization",
  });
  const calls = [],
    unexpected = [];
  let runtime,
    javascript,
    stylesheet,
    manager = true,
    hold,
    failReply = false;
  const server = createServer(async (request, response) => {
    try {
      const body = async () => {
        let value = "";
        for await (const chunk of request) value += chunk;
        return value;
      };
      const json = (value) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (request.url === "/main.js") {
        response.setHeader("content-type", "text/javascript");
        response.end(javascript);
      } else if (request.url === "/main.css") {
        response.setHeader("content-type", "text/css");
        response.end(stylesheet);
      } else if (request.url === "/font.woff2") {
        response.setHeader("content-type", "font/woff2");
        response.end(
          readFileSync(
            join(root, ".upstream/packages/ui/src/implementation/styles/fonts/geist-sans.woff2"),
          ),
        );
      } else if (request.url === "/") {
        response.setHeader("content-type", "text/html");
        response.end(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/main.css"></head><body><script type="application/json" id="executor-context">{"version":"fixture"}</script><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
        );
      } else if (request.url === "/_executor/api/pool-usage/summary") {
        const { input } = JSON.parse(await body());
        if (!manager) {
          response.writeHead(403).end();
          return;
        }
        json(summaryReply(input));
      } else if (request.url === "/_executor/api/pool-usage/personal-overview") {
        response.writeHead(503).end();
      } else if (
        request.url === "/_executor/api/query" ||
        request.url === "/_executor/api/mutate"
      ) {
        const { name, input } = JSON.parse(await body());
        const result = await runtime.invoke(
          request.url.endsWith("mutate") ? "mutate" : "query",
          name,
          input,
          token,
          manager ? "fixture-manager" : "fixture-member",
          true,
        );
        assert.equal(result.ok, true, JSON.stringify(result));
        json(result.value);
      } else if (request.url?.startsWith("/pool/v1/")) {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        if (request.url === "/pool/v1/usage/import/self") {
          const text = await body(),
            page = JSON.parse(text);
          calls.push(page);
          const waiting = hold;
          if (waiting && page.mode === "apply") {
            hold = undefined;
            waiting.arrived();
            await waiting.release;
          }
          const result = await handleSelfUsageImport(
            new Request(`${origin}${request.url}`, {
              method: request.method,
              headers: request.headers,
              body: text,
            }),
            {
              signingKey,
              connectionString,
              permissions: async (_pool, caller) => ({
                canUse: true,
                canManage: caller === owner || caller === "fixture-manager",
              }),
            },
          );
          if (failReply && page.mode === "apply") {
            failReply = false;
            response.destroy();
            return;
          }
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(await result.text());
        } else if (request.url.startsWith("/pool/v1/pool"))
          json({ isOwner: false, providers: [], accounts: [] });
        else if (request.url.startsWith("/pool/v1/setup-context"))
          json({
            href: origin,
            computers: [],
            undoPrompt: "",
            ...(manager ? { shareHref: origin + "/settings" } : {}),
          });
        else if (request.url.startsWith("/pool/v1/usage/capacity")) {
          const input = new URL(request.url, origin).searchParams;
          json(
            capacityFixture({ days: Number(input.get("days")), to: Number(input.get("to")) }).value,
          );
        } else if (request.url.startsWith("/pool/v1/usage/summary")) json(usage);
        else {
          unexpected.push(request.url);
          response.writeHead(404).end();
        }
      } else if (
        request.url === "/favicon.ico" ||
        request.url?.startsWith("/_executor/api/telemetry/")
      )
        response.writeHead(204).end();
      else {
        unexpected.push(request.url);
        response.writeHead(404).end();
      }
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const built = await buildApp(directory, origin);
    javascript = built.javascript;
    stylesheet = built.stylesheet;
    runtime = built.runtime;
  } catch (error) {
    await close();
    throw error;
  }
  return {
    origin,
    calls,
    unexpected,
    close,
    agentImport: (input) => runtime.invoke("call", "importUsage", input, token, "fixture-manager"),
    member: () => {
      manager = false;
    },
    loseApplyReply: () => {
      failReply = true;
    },
    holdApply: () => {
      let arrived, release;
      const started = new Promise((resolve) => {
        arrived = resolve;
      });
      const waiting = new Promise((resolve) => {
        release = resolve;
      });
      hold = { arrived, release: waiting };
      return { started, release };
    },
  };
}

async function buildApp(directory, origin) {
  const app = join(directory, "apps/pool");
  // Use the shipped source graph, including relocated host files and their imports.
  for (const file of bundlePoolApp(root, join(root, ".upstream"))) {
    const path = join(app, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  writeFileSync(
    join(app, "deployment.ts"),
    `export const poolOrigin = ${JSON.stringify(origin)}; export const productName = "Signalbox";`,
  );
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(directory, "tsconfig.json"), '{"compilerOptions":{"jsx":"react-jsx"}}');
  symlinkSync(
    join(root, ".upstream/apps/hosted/cloud/node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  mkdirSync(join(app, "node_modules"));
  const webRequire = createRequire(join(root, ".upstream/apps/hosted/web/package.json"));
  for (const name of ["react", "react-dom", "tailwindcss"])
    symlinkSync(
      join(webRequire.resolve(`${name}/package.json`), ".."),
      join(app, "node_modules", name),
      "dir",
    );
  symlinkSync(join(root, ".upstream/packages/apps"), join(app, "node_modules/apps"), "dir");
  writeFileSync(
    join(directory, "host.ts"),
    `import app from './apps/pool/index.ts';
import {createAppHandler,hostContext} from 'apps/host';
const handler=createAppHandler(app);
const request=(value)=>new Request('https://app.example.test',{method:'POST',body:JSON.stringify(value)});
const requirements=await (await handler(request({operation:'requirements'}),hostContext({app:{}}))).json();
if(!requirements.ok)throw new Error(JSON.stringify(requirements));
export const invoke=async(operation,name,input,token,caller,human=false)=>{
 const empty=Object.fromEntries(Object.entries(requirements.value.accounts.app).filter(([,slot])=>slot.cardinality==='many').map(([name])=>[name,[]]));
 const accounts={app:{...empty,pool:{id:'acc_fixture_pool_token',provider:requirements.value.accounts.app.pool.definition,method:'token',fields:{token}}},user:{}};
 return (await handler(request({operation,...(operation==='call'?{tool:name}:{name}),input}),hostContext(accounts,undefined,caller))).json();
};`,
  );
  const built = spawnSync(
    process.env.BUN_BINARY ?? "bun",
    [
      "-e",
      `
for(const [entry,target] of [['apps/pool/ui/main.tsx','browser'],['host.ts','node']]){
 const result=await Bun.build({entrypoints:[${JSON.stringify(directory)}+'/'+entry],outdir:${JSON.stringify(join(directory, "dist"))},target,define:{'process.env.NODE_ENV':'"development"'}});
 if(!result.success){console.error(result.logs);process.exit(1);}
}`,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr + built.stdout);
  const javascript = readFileSync(join(directory, "dist/main.js"));
  const { build } = require("esbuild");
  const styles = await build({
    entryPoints: [join(app, "ui/style.css")],
    write: false,
    bundle: true,
    outfile: "main.css",
    conditions: ["style"],
    alias: { tailwindcss: join(root, ".upstream/packages/ui/node_modules/tailwindcss/index.css") },
  });
  const { compile } = webRequire("tailwindcss");
  const { Scanner } = createRequire(
    realpathSync(
      join(root, ".upstream/apps/hosted/web/node_modules/@tailwindcss/vite/package.json"),
    ),
  )("@tailwindcss/oxide");
  const candidates = new Scanner({ sources: [] }).scanFiles([
    { content: javascript.toString(), extension: "js" },
  ]);
  const stylesheet =
    "@font-face{font-family:Geist;src:url(/font.woff2);font-weight:100 900}" +
    (await compile(styles.outputFiles[0].text)).build(candidates);
  const runtime = await import(pathToFileURL(join(directory, "dist/host.js")).href);
  return { javascript, stylesheet, runtime };
}
