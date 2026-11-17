import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { observeAppActivation } from "../.upstream/e2e/support/app-activation-observer.ts";
import { batchPath, splitRoutedReads } from "../.upstream/e2e/support/read-batches.ts";

const { chromium } = createRequire(new URL("../.upstream/package.json", import.meta.url))(
  "playwright",
);

async function fixture(t, streamed = true) {
  const streams = new Set();
  let locationReads = 0;
  const server = createServer((request, response) => {
    if (request.url === "/app") {
      response.setHeader("content-type", "application/json");
      if (!streamed) {
        response.end('{"activeVersion":"activated-version"}\n');
        return;
      }
      response.write('{"activeVersion":"activated-version"}\n');
      streams.add(response);
      response.on("close", () => streams.delete(response));
      return;
    }
    if (request.url === "/location") {
      locationReads++;
      response.end("ready");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><button>Activate</button><h1>Before</h1><script>
      document.querySelector('button').onclick = async () => {
        const response = await fetch('/app');
        await response.body.getReader().read();
        await fetch('/location');
        document.querySelector('h1').textContent = 'Activated';
      };
      document.addEventListener('visibilitychange', () => fetch('/location'));
    </script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    for (const stream of streams) stream.destroy();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  return { page, reads: () => locationReads };
}

const activate = async (page) => {
  await page.getByRole("button", { name: "Activate" }).click();
  await page.getByRole("heading", { name: "Activated", exact: true }).waitFor();
};

test("location traffic cannot confirm an unfinished app response", async (t) => {
  const f = await fixture(t);
  const observed = await observeAppActivation(f.page, (url) => url.pathname === "/app");
  await activate(f.page);
  assert.equal(f.reads(), 1);
  await assert.rejects(observed.waitForVersion("activated-version"), { name: "TimeoutError" });
  assert.equal(f.reads(), 2);
});

test("a completed version body received before the check confirms activation", async (t) => {
  const { page } = await fixture(t, false);
  const observed = await observeAppActivation(page, (url) => url.pathname === "/app");
  await activate(page);
  await observed.waitForVersion("activated-version");
});

test("a version substring cannot confirm activation", async (t) => {
  const { page } = await fixture(t, false);
  const observed = await observeAppActivation(page, (url) => url.pathname === "/app");
  await activate(page);
  await assert.rejects(observed.waitForVersion("activated"), { name: "TimeoutError" });
});

for (const beforeCheck of [true, false]) {
  const name = `an activation delivered ${beforeCheck ? "before" : "after"} the check is observed while a batch sibling stays held`;
  // Bounds a sibling that never reaches the server; the observer's own deadline is 15 s.
  test(name, { timeout: 30_000 }, async (t) => {
    const streams = new Set();
    let held;
    const siblingHeld = new Promise((resolve) => (held = resolve));
    const app = { activeVersion: "activated-version" };
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/openapi.json") {
        response.end(
          JSON.stringify({
            paths: {
              "/app": { get: { operationId: "apps.get" } },
              "/sibling": { get: { operationId: "apps.sibling" } },
            },
          }),
        );
      } else if (request.url === "/app") {
        response.end(JSON.stringify(app));
      } else if (request.url === batchPath) {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          response.setHeader("content-type", "application/x-ndjson");
          for (const read of JSON.parse(body).reads) {
            if (read.endpoint === "get") {
              response.write(
                `${JSON.stringify({ id: read.id, status: 200, text: JSON.stringify(app) })}\n`,
              );
            }
          }
          response.flushHeaders();
          streams.add(response);
          response.on("close", () => streams.delete(response));
          held();
        });
      } else {
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html><button>Activate</button><h1>Before</h1><script>
        document.querySelector('button').onclick = async () => {
          const reads = ['get', 'sibling'].map((endpoint, id) => ({ id, group: 'apps', endpoint, params: {}, query: {} }));
          const response = await fetch('${batchPath}', { method: 'POST', body: JSON.stringify({ reads }) });
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffered = '';
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            buffered += decoder.decode(chunk.value, { stream: true });
            const lines = buffered.split('\\n');
            buffered = lines.pop();
            for (const line of lines) {
              if (!line) continue;
              const result = JSON.parse(line);
              if (result.id === 0 && JSON.parse(result.text).activeVersion === 'activated-version') {
                document.querySelector('h1').textContent = 'Activated';
              }
            }
          }
        };
      </script>`);
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    let observed;
    t.after(async () => {
      try {
        await observed?.dispose();
      } finally {
        await browser.close();
      }
      for (const stream of streams) stream.destroy();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    });
    const context = await browser.newContext();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await splitRoutedReads(context, origin);
    const page = await context.newPage();
    await page.goto(origin);
    observed = await observeAppActivation(page, (url) => url.pathname === "/app");
    if (beforeCheck) {
      await activate(page);
      await siblingHeld;
      assert.equal(streams.size, 1);
      await observed.waitForVersion("activated-version");
    } else {
      const ready = observed.waitForVersion("activated-version");
      await activate(page);
      await siblingHeld;
      assert.equal(streams.size, 1);
      await ready;
    }
  });
}
