import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { observeAppActivation } from "../.upstream/e2e/support/app-activation-observer.ts";

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

test("activation observed before the frame update survives an unreadable streamed body", async (t) => {
  const f = await fixture(t);
  const observed = observeAppActivation(
    f.page,
    (response) => new URL(response.url()).pathname === "/app",
    (request) => (new URL(request.url()).pathname === "/location" ? 1 : 0),
  );
  await activate(f.page);
  assert.equal(f.reads(), 1);
  await observed.waitForVersion("activated-version");
  assert.equal(f.reads(), 2);
});

test("a completed version body received before the check confirms activation", async (t) => {
  const { page } = await fixture(t, false);
  const observed = observeAppActivation(
    page,
    (response) => new URL(response.url()).pathname === "/app",
    () => 0,
  );
  await activate(page);
  await observed.waitForVersion("activated-version");
});

test("an unrelated version body without both location reads keeps the existing deadline", async (t) => {
  const { page } = await fixture(t, false);
  const observed = observeAppActivation(
    page,
    (response) => new URL(response.url()).pathname === "/app",
    () => 0,
  );
  await activate(page);
  await assert.rejects(observed.waitForVersion("unrelated-version"), { name: "TimeoutError" });
});
