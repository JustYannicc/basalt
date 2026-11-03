import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, ".upstream/package.json"));
const { chromium } = require("playwright");
const ready = { name: "basalt:pool-accounts-ready", version: 1 };
const failed = { ok: false, error: "backend_unavailable", message: "Synthetic pool failure" };
const empty = { isOwner: true, providers: [], accounts: [] };

test(
  "the committed pool view reports readiness once to its parent, including StrictMode and refresh",
  { timeout: 90_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "pool-ready-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let childOrigin = "";
    const parent = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/spoof") {
        response.end(
          `<script>parent.postMessage(${JSON.stringify(ready)}, location.origin)</script><p>Wrong origin sent</p>`,
        );
        return;
      }
      response.end(`<script>
      window.readiness = [];
      window.rejected = 0;
      addEventListener('message', event => {
        if (event.data?.name !== 'basalt:pool-accounts-ready') return;
        const frame = document.querySelector('iframe');
        if (event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) { window.rejected++; return; }
        const data = event.data;
        if (data.version !== 1 || Object.keys(data).length !== 2) { window.rejected++; return; }
        window.readiness.push({ data, at: performance.now() });
      });
    </script><iframe src="${childOrigin}"></iframe>`);
    });
    await new Promise((resolve) => parent.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => parent.close(() => resolve())));
    const parentAddress = parent.address();
    assert.ok(parentAddress && typeof parentAddress !== "string");
    const parentOrigin = `http://127.0.0.1:${parentAddress.port}`;

    // Use the same source and entry point as the shipped app; only the deployment origin changes.
    const app = join(directory, "app");
    cpSync(join(root, "apps/pool"), app, {
      recursive: true,
      filter: (path) => !path.includes("node_modules") && !/\.(test|spec)\./.test(path),
    });
    writeFileSync(
      join(app, "deployment.ts"),
      `export const poolOrigin = ${JSON.stringify(parentOrigin)}; export const productName = "Signalbox";`,
    );
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
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
    const built = spawnSync(
      process.env.BUN_BINARY ?? "bun",
      [
        "-e",
        `
    const result = await Bun.build({ entrypoints: [${JSON.stringify(join(app, "ui/main.tsx"))}],
      outdir: ${JSON.stringify(join(directory, "dist"))}, target: 'browser',
      define: { 'process.env.NODE_ENV': '"development"' } });
    if (!result.success) { console.error(result.logs); process.exit(1); }
  `,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stderr + built.stdout);
    const javascript = readFileSync(join(directory, "dist/main.js"));
    let held = [];
    let arrived = () => {};
    let viewResult = failed;
    const child = createServer(async (request, response) => {
      if (request.url === "/main.js") {
        response.setHeader("content-type", "application/javascript");
        response.end(javascript);
      } else if (request.url === "/_executor/api/query") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const { name } = JSON.parse(body);
        response.setHeader("content-type", "application/json");
        if (name === "view") {
          held.push(response);
          arrived();
        } else response.end(JSON.stringify(failed));
      } else if (request.url === "/") {
        response.setHeader("content-type", "text/html");
        response.end(
          '<script type="application/json" id="executor-context">{"version":"fixture"}</script><div id="root"></div><script type="module" src="/main.js"></script>',
        );
      } else response.writeHead(204).end();
    });
    await new Promise((resolve) => child.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => child.close(() => resolve())));
    const childAddress = child.address();
    assert.ok(childAddress && typeof childAddress !== "string");
    childOrigin = `http://127.0.0.1:${childAddress.port}`;
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const release = () => {
      for (const response of held.splice(0)) response.end(JSON.stringify(viewResult));
    };
    const requests = (count) =>
      new Promise((resolve) => {
        arrived = () => {
          if (held.length >= count) resolve();
        };
        arrived();
      });

    for (const populated of [false, true])
      await t.test(populated ? "account rows" : "authorized empty result", async () => {
        viewResult = failed;
        held = [];
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.addInitScript(() => {
            const mark = performance.mark.bind(performance);
            performance.mark = (name, options) => {
              const result = mark(name, options);
              if (name === "basalt:pool-accounts-ready")
                document.documentElement.dataset.committedAtReady = document.body.textContent ?? "";
              return result;
            };
          });
          await page.goto(parentOrigin);
          await requests(2); // Development StrictMode replays the real mount effect.
          const frame = page.frames().find((frame) => frame.url() === `${childOrigin}/`);
          assert.ok(frame);
          const accepted = () => page.evaluate(() => Reflect.get(window, "readiness"));
          assert.deepEqual(await accepted(), []);
          release();
          await frame.getByText("Synthetic pool failure", { exact: true }).waitFor();
          assert.equal(
            await frame.evaluate(
              () => performance.getEntriesByName("basalt:pool-accounts-ready").length,
            ),
            0,
          );
          assert.deepEqual(await accepted(), []);
          // Unrelated sources and unsupported contracts cannot satisfy the parent probe.
          await page.evaluate((data) => window.postMessage(data, location.origin), ready);
          await frame.evaluate(
            ({ origin, data }) => window.parent.postMessage({ ...data, version: 2 }, origin),
            { origin: parentOrigin, data: ready },
          );
          await page.waitForFunction(() => Reflect.get(window, "rejected") === 2);
          assert.deepEqual(await accepted(), []);

          const value = populated
            ? {
                ...empty,
                accounts: [
                  {
                    id: "fixture-account",
                    provider: "fixture",
                    label: "Synthetic subscription",
                    plan: null,
                    state: "active",
                    message: null,
                    windows: [],
                    observedAt: null,
                    freshness: "never",
                    readingFailed: false,
                    nextReadAt: null,
                    earliestResetAt: null,
                    bankedResets: null,
                  },
                ],
              }
            : empty;
          viewResult = { ok: true, value };
          await frame.getByRole("button", { name: "Try again", exact: true }).click();
          await requests(1);
          release();
          const visible = populated ? "Synthetic subscription" : "No accounts yet.";
          await frame.getByText(visible, { exact: true }).waitFor();
          await page.waitForFunction(() => Reflect.get(window, "readiness").length === 1);
          assert.deepEqual(
            (await accepted()).map((entry) => entry.data),
            [ready],
          );
          assert.ok(
            (await frame.locator("html").getAttribute("data-committed-at-ready"))?.includes(
              visible,
            ),
          );
          assert.equal(
            await frame.evaluate(
              () => performance.getEntriesByName("basalt:pool-accounts-ready").length,
            ),
            1,
          );
          await frame.evaluate(() => {
            const now = Date.now();
            Date.now = () => now + 60_001;
          });
          await page.evaluate((origin) => {
            const frame = document.querySelector("iframe");
            frame.contentWindow.postMessage({ type: "executor:app-active", active: false }, origin);
            frame.contentWindow.postMessage({ type: "executor:app-active", active: true }, origin);
          }, childOrigin);
          await requests(1);
          viewResult = { ok: true, value: empty };
          release();
          await frame.getByText("No accounts yet.", { exact: true }).waitFor();
          assert.equal(
            await frame.evaluate(
              () => performance.getEntriesByName("basalt:pool-accounts-ready").length,
            ),
            1,
          );
          assert.equal((await accepted()).length, 1);
          // Keep the same WindowProxy, changing only its actual origin.
          await frame.goto(`${parentOrigin}/spoof`);
          await page.waitForFunction(() => Reflect.get(window, "rejected") === 3);
          assert.equal((await accepted()).length, 1);
        } finally {
          release();
          await context.close();
        }
      });
  },
);
